#!/usr/bin/env node
// Sync GitHub Release bodies and titles from each package's CHANGELOG.md.
//
// Most common use: a package's first npm release. CI publish 403s because
// no trusted publisher is configured for a brand-new package, the standard
// recovery is `pnpm exec changeset publish` locally, and the GitHub
// release body ends up wrong (auto-generated PR list, or empty). Run this
// to sync the body from CHANGELOG.md retroactively.
//
// Also useful when migrating a repo off `gh release create --generate-notes`
// to canonical `changesets/action`-authored bodies.
//
// Mirrors the canonical changesets-action algorithm: parse each
// package's CHANGELOG.md, locate the section under the `## <version>`
// heading matching the release tag, and post that as the release body.
//
// Auth: GH_TOKEN env var, e.g. `GH_TOKEN=$(gh auth token) npx @polygonlabs/sync-github-releases ...`.
// Dry-run by default; pass --apply to actually update releases.

import type { Heading, Root } from 'mdast';
import type { Options as StringifyOptions } from 'remark-stringify';

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { confirm } from '@inquirer/prompts';
import { throttling } from '@octokit/plugin-throttling';
import { Octokit } from '@octokit/rest';
import { toString as mdastToString } from 'mdast-util-to-string';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

// Match the markdown serialisation that `changesets/action@v1.x` emits for
// release bodies, byte-for-byte. The action pins `remark-stringify@^7.0.3`,
// whose v7 defaults were `bullet: '-'` and `listItemIndent: 'tab'`
// (4-space content indent). Modern remark-stringify defaults to
// `bullet: '*'` and `listItemIndent: 'one'`, so without these options our
// extraction would round-trip every CHANGELOG.md to a different markdown
// shape than the action and every release would flag cosmetic-only.
//
// With these options, releases authored by the action serialise byte-equal
// to our extraction — `[match]` is a strict byte comparison. Releases
// stored under any other shape (e.g. `gh release create --generate-notes`
// output, or anything written by an earlier version of this tool that
// used the modern remark defaults) flag as `[would-update]` and get
// rewritten under `--apply` to the canonical form.
const STRINGIFY_OPTIONS: StringifyOptions = { bullet: '-', listItemIndent: 'tab' };

interface CliOptions {
  repos: string[];
  apply: boolean;
  yes: boolean;
  summary: boolean;
  tag?: string;
}

interface PendingUpdate {
  owner: string;
  repoName: string;
  releaseId: number;
  tag: string;
  proposedBody: string;
}

interface RepoSummary {
  repo: string;
  inspected: number;
  pending: number;
  updated: number;
  errors: number;
  skippedNoMatch: number;
  skippedUnparseable: number;
  alreadyMatch: number;
}

const log = (msg: string): void => {
  console.log(msg);
};

const run = (cmd: string, args: string[], cwd?: string): void => {
  execFileSync(cmd, args, { stdio: 'inherit', cwd });
};

const capture = (cmd: string, args: string[], cwd?: string): string =>
  execFileSync(cmd, args, {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    cwd
  });

// Pre-flight check that a required external binary is on PATH. The two
// shell-outs (`gh repo clone`, `git fetch && git reset`) raise an opaque
// `spawnSync ENOENT` deep inside processRepo otherwise; catch it up front
// so the user gets a clear message and an install hint.
const requireBinary = (name: string, installHint: string): void => {
  try {
    execFileSync(name, ['--version'], { stdio: 'ignore' });
  } catch {
    console.error(`ERROR: '${name}' was not found on PATH. Install it and re-run.`);
    console.error(installHint);
    process.exit(1);
  }
};

// Stable cross-run cache. tmpdir keeps cwd clean and is auto-pruned by the OS;
// a stable path means re-running for the same repo reuses the existing clone
// rather than re-downloading.
const CLONES_DIR = join(tmpdir(), 'sync-github-releases', 'repos');

/**
 * Idempotently produce a fresh shallow checkout for a repo. Reuses an
 * existing clone when present — re-runs do `git fetch && git reset` against
 * the default branch instead of re-cloning.
 */
const ensureClone = (repo: string, defaultBranch: string): string => {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`Invalid --repo value: '${repo}' (expected owner/name)`);
  const path = join(CLONES_DIR, `${owner}-${name}`);

  if (!existsSync(path)) {
    log(`[${repo}] cloning into ${path}`);
    run('gh', ['repo', 'clone', repo, path, '--', '--depth=1', `--branch=${defaultBranch}`]);
    return path;
  }

  log(`[${repo}] refreshing existing clone at ${path}`);
  run('git', ['fetch', '--depth=1', 'origin', defaultBranch], path);
  run('git', ['reset', '--hard', `origin/${defaultBranch}`], path);
  return path;
};

interface PnpmListEntry {
  name?: string;
  path: string;
}

/**
 * Use `pnpm m ls --depth=-1 --json` to enumerate every package in the local
 * clone and build a `name → CHANGELOG.md` path map. Works for pnpm workspaces
 * (returns the root + every workspace package) and for plain single-package
 * repos (returns just the root). Repos without a `package.json` at the root,
 * or without `pnpm-workspace.yaml` for a workspace layout, won't enumerate
 * sub-packages — those releases simply skip.
 */
const buildPackageChangelogMap = (repoRoot: string): Map<string, string> => {
  const map = new Map<string, string>();

  let json: string;
  try {
    json = capture('pnpm', ['-C', repoRoot, 'm', 'ls', '--depth=-1', '--json']);
  } catch {
    // pnpm couldn't enumerate (no package.json, lockfile mismatch, etc.).
    // Fall through with an empty map; per-release verdicts will report
    // [skip: no changelog match] for each tag.
    return map;
  }

  const entries: PnpmListEntry[] = JSON.parse(json);
  for (const entry of entries) {
    if (!entry.name) continue;
    const changelog = join(entry.path, 'CHANGELOG.md');
    if (existsSync(changelog)) map.set(entry.name, changelog);
  }
  return map;
};

/**
 * Extract the section under `## <version>` from a CHANGELOG.md string.
 * Mirrors changesets/action's `getChangelogEntry` — parses with remark, walks
 * the AST for the heading whose text matches the version, and returns
 * everything from the next sibling up to (but not including) the next
 * heading at the same depth. AST-based rather than string-based so headings
 * inside code fences or with unusual whitespace don't trip it up.
 *
 * Reference: https://github.com/changesets/action/blob/main/src/utils.ts
 */
const extractChangelogEntry = (changelog: string, version: string): string => {
  const ast = unified().use(remarkParse).parse(changelog) as Root;

  let headingStart: { index: number; depth: number } | undefined;
  let endIndex: number | undefined;

  for (const [i, node] of ast.children.entries()) {
    if (node.type !== 'heading') continue;
    const heading = node as Heading;
    const text = mdastToString(heading);

    if (headingStart === undefined && text === version) {
      headingStart = { index: i, depth: heading.depth };
      continue;
    }
    if (headingStart !== undefined && heading.depth === headingStart.depth) {
      endIndex = i;
      break;
    }
  }

  if (headingStart === undefined) return '';

  const slice: Root = {
    ...ast,
    children: ast.children.slice(headingStart.index + 1, endIndex)
  };
  return unified().use(remarkStringify, STRINGIFY_OPTIONS).stringify(slice).trim();
};

/**
 * Tag format is `<name>@<version>` or `@scope/name@version`. Split at the
 * LAST `@` so scoped names parse correctly. Returns undefined for tags that
 * don't fit the form (e.g. `v1.0.0`, plain SHAs).
 */
const splitTag = (tag: string): { name: string; version: string } | undefined => {
  const at = tag.lastIndexOf('@');
  if (at <= 0) return undefined;
  const name = tag.slice(0, at);
  const version = tag.slice(at + 1);
  if (!name || !version) return undefined;
  // Heuristic: version must look at least vaguely semver-ish (starts with a digit).
  if (!/^\d/.test(version)) return undefined;
  return { name, version };
};

/**
 * Print a simple unified-style line-by-line diff between two strings. Not a
 * real diff algorithm — just a side-by-side dump of removed/added lines so
 * the operator can eyeball the change before re-running with --apply.
 */
const printDiff = (current: string, proposed: string): void => {
  const currentLines = current.split('\n');
  const proposedLines = proposed.split('\n');
  console.log('  --- current');
  for (const line of currentLines) console.log(`  - ${line}`);
  console.log('  +++ proposed');
  for (const line of proposedLines) console.log(`  + ${line}`);
};

/**
 * Analyse one repo: clone, list releases, decide a verdict per release.
 * Releases that need updating are appended to `pending` rather than written
 * — the actual writes happen only after the operator confirms in `applyUpdates`.
 */
const processRepo = async (
  repo: string,
  octokit: Octokit,
  pending: PendingUpdate[],
  showDiff: boolean,
  tagFilter?: string
): Promise<RepoSummary> => {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`Invalid repo: ${repo}`);

  const summary: RepoSummary = {
    repo,
    inspected: 0,
    pending: 0,
    updated: 0,
    errors: 0,
    skippedNoMatch: 0,
    skippedUnparseable: 0,
    alreadyMatch: 0
  };

  log(`\n=== ${repo}${tagFilter ? ` (filter: --tag ${tagFilter})` : ''} ===`);

  const { data: repoData } = await octokit.repos.get({ owner, repo: name });
  const defaultBranch = repoData.default_branch;
  const repoRoot = ensureClone(repo, defaultBranch);

  const changelogMap = buildPackageChangelogMap(repoRoot);
  log(`[${repo}] discovered ${changelogMap.size} package(s) with CHANGELOG.md`);

  const allReleases = await octokit.paginate(octokit.repos.listReleases, {
    owner,
    repo: name,
    per_page: 100
  });

  let releases = allReleases;
  if (tagFilter !== undefined) {
    releases = allReleases.filter((r) => r.tag_name === tagFilter);
    if (releases.length === 0) {
      log(
        `  [error] tag '${tagFilter}' not found among ${allReleases.length} release(s) in ${repo}`
      );
      summary.errors++;
      return summary;
    }
  }
  log(`[${repo}] processing ${releases.length} release(s)`);

  for (const release of releases) {
    summary.inspected++;
    const tag = release.tag_name;

    const parsed = splitTag(tag);
    if (!parsed) {
      log(`  [skip: tag unparseable] ${tag}`);
      summary.skippedUnparseable++;
      continue;
    }

    const { name: pkgName, version } = parsed;
    const changelogPath = changelogMap.get(pkgName);
    if (!changelogPath) {
      log(`  [skip: no changelog match] ${tag} (no package '${pkgName}' with CHANGELOG.md)`);
      summary.skippedNoMatch++;
      continue;
    }

    const changelogText = readFileSync(changelogPath, 'utf8');
    const proposedBody = extractChangelogEntry(changelogText, version);
    if (!proposedBody) {
      log(
        `  [skip: no changelog match] ${tag} (no '## ${version}' section in ${relative(repoRoot, changelogPath)})`
      );
      summary.skippedNoMatch++;
      continue;
    }

    const currentBody = (release.body ?? '').trim();
    if (currentBody === proposedBody && release.name === tag) {
      log(`  [match] ${tag}`);
      summary.alreadyMatch++;
      continue;
    }

    log(`  [would-update] ${tag}`);
    if (showDiff) printDiff(currentBody, proposedBody);
    pending.push({ owner, repoName: name, releaseId: release.id, tag, proposedBody });
    summary.pending++;
  }

  return summary;
};

/**
 * Phase 2 of `--apply`: walk the pending list and call `repos.updateRelease`
 * for each. Per-release try/catch so a single 5xx doesn't strand the rest;
 * the throttling plugin on the Octokit instance handles GitHub's primary
 * and secondary rate limits with backoff.
 */
const applyUpdates = async (
  octokit: Octokit,
  pending: PendingUpdate[],
  summaries: RepoSummary[]
): Promise<void> => {
  log('\n=== Applying ===');
  for (const u of pending) {
    const repoKey = `${u.owner}/${u.repoName}`;
    const s = summaries.find((x) => x.repo === repoKey);
    try {
      await octokit.repos.updateRelease({
        owner: u.owner,
        repo: u.repoName,
        release_id: u.releaseId,
        name: u.tag,
        body: u.proposedBody
      });
      log(`  [updated] ${repoKey} ${u.tag}`);
      if (s) {
        s.updated++;
        s.pending--;
      }
    } catch (err) {
      log(`  [error]   ${repoKey} ${u.tag}: ${err instanceof Error ? err.message : err}`);
      if (s) {
        s.errors++;
        s.pending--;
      }
    }
  }
};

const printSummary = (summaries: RepoSummary[]): void => {
  log('\n=== Summary ===');
  for (const s of summaries) {
    log(
      `${s.repo}: inspected=${s.inspected} match=${s.alreadyMatch} pending=${s.pending} updated=${s.updated} errors=${s.errors} skip-no-match=${s.skippedNoMatch} skip-unparseable=${s.skippedUnparseable}`
    );
  }
};

const ThrottledOctokit = Octokit.plugin(throttling);

const run_ = async ({
  repos,
  apply,
  yes,
  summary: summaryOnly,
  tag
}: CliOptions): Promise<void> => {
  const token = process.env.GH_TOKEN?.trim();
  if (!token) {
    console.error('ERROR: GH_TOKEN env var is required (and non-empty).');
    console.error(
      'Get one with `gh auth token` (run `gh auth login` first if needed):\n' +
        '\n' +
        '  GH_TOKEN=$(gh auth token) npx @polygonlabs/sync-github-releases --repo <owner>/<name>'
    );
    process.exit(1);
  }

  requireBinary('gh', '  brew install gh    # or see https://cli.github.com/');
  requireBinary('git', '  brew install git   # or see https://git-scm.com/');
  requireBinary(
    'pnpm',
    '  brew install pnpm  # or see https://pnpm.io/installation\n  (used to enumerate workspace packages in each cloned repo)'
  );

  await mkdir(CLONES_DIR, { recursive: true });

  const octokit = new ThrottledOctokit({
    auth: token,
    throttle: {
      onRateLimit: (retryAfter, options, _octokit, retryCount) => {
        console.warn(
          `Rate limited on ${options.method} ${options.url}; retrying in ${retryAfter}s (attempt ${retryCount + 1}/3)`
        );
        return retryCount < 3;
      },
      onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) => {
        console.warn(
          `Secondary rate limit on ${options.method} ${options.url}; retrying in ${retryAfter}s (attempt ${retryCount + 1}/3)`
        );
        return retryCount < 3;
      }
    }
  });

  log(
    `Mode: ${apply ? 'APPLY (will write release bodies after confirmation)' : 'dry-run (no writes)'}`
  );
  log(`Targets: ${repos.join(', ')}`);

  const summaries: RepoSummary[] = [];
  const pending: PendingUpdate[] = [];
  for (const repo of repos) {
    try {
      summaries.push(await processRepo(repo, octokit, pending, !summaryOnly, tag));
    } catch (err) {
      console.error(`\nERROR processing ${repo}:`, err instanceof Error ? err.message : err);
    }
  }

  printSummary(summaries);

  if (!apply) return;

  if (pending.length === 0) {
    log('\nNothing to update.');
    return;
  }

  const repoCount = new Set(pending.map((p) => `${p.owner}/${p.repoName}`)).size;
  log(
    `\n${pending.length} release ${pending.length === 1 ? 'body' : 'bodies'} pending update across ${repoCount} repo(s).`
  );

  if (!yes) {
    if (!process.stdin.isTTY) {
      console.error(
        'Non-interactive stdin detected; cannot prompt for confirmation. Pass --yes to apply without prompting.'
      );
      process.exit(1);
    }
    const ok = await confirm({ message: 'Proceed with --apply?', default: false });
    if (!ok) {
      log('Aborted.');
      return;
    }
  }

  await applyUpdates(octokit, pending, summaries);
  printSummary(summaries);
};

// Shared modifier flags. Both subcommands accept the same set; only their
// positional arguments differ.
const sharedOptions = {
  apply: {
    type: 'boolean' as const,
    default: false,
    describe: 'Write changes via the GitHub API. Without this flag, only diffs are printed.'
  },
  yes: {
    type: 'boolean' as const,
    default: false,
    alias: 'y',
    describe:
      'Skip the confirmation prompt before applying. Implies --apply. Use only when you have already inspected a dry-run.'
  },
  summary: {
    type: 'boolean' as const,
    default: false,
    describe:
      'Suppress per-release diffs; print only verdict lines. Useful for large repos where the full diff would be unwieldy.'
  }
};

await yargs(hideBin(process.argv))
  .scriptName('sync-github-releases')
  .usage("$0 <command>\n\nSync GitHub Release bodies and titles from each package's CHANGELOG.md.")
  .command(
    'release <repo> <tag>',
    'Sync a single release in one repo. Use after a recovery publish for one new package.',
    (y) =>
      y
        .positional('repo', {
          type: 'string',
          demandOption: true,
          describe: 'Target repository as <owner>/<name>.'
        })
        .positional('tag', {
          type: 'string',
          demandOption: true,
          describe: 'Release tag, e.g. "@polygonlabs/foo@1.2.3".'
        })
        .options(sharedOptions)
        .example(
          '$0 release 0xPolygon/apps-team-packages @polygonlabs/foo@1.0.0 --apply',
          'Sync just the @polygonlabs/foo@1.0.0 release in apps-team-packages'
        ),
    async (argv) => {
      const apply = argv.apply || argv.yes;
      await run_({
        repos: [argv.repo],
        apply,
        yes: argv.yes,
        summary: argv.summary,
        tag: argv.tag
      });
    }
  )
  .command(
    'repos <repo..>',
    'Sync every release in one or more repos. Whole-repo canonicalisation pass.',
    (y) =>
      y
        .positional('repo', {
          type: 'string',
          array: true,
          demandOption: true,
          describe: 'One or more repositories as <owner>/<name>.'
        })
        .options(sharedOptions)
        .example(
          '$0 repos 0xPolygon/apps-team-packages 0xPolygon/lst-api --apply',
          'Sync every release across two repos'
        ),
    async (argv) => {
      const apply = argv.apply || argv.yes;
      await run_({
        repos: argv.repo,
        apply,
        yes: argv.yes,
        summary: argv.summary
      });
    }
  )
  .demandCommand(1, 'Specify a subcommand: `release` or `repos`.')
  .strict()
  .help()
  .alias('h', 'help')
  .epilogue(
    [
      'Auth: set GH_TOKEN to a token with contents:write on each target repo.',
      'The convenient source is the gh CLI:',
      '',
      '  GH_TOKEN=$(gh auth token) npx @polygonlabs/sync-github-releases release <repo> <tag>',
      '',
      'Run `gh auth login` first if `gh auth token` returns nothing.'
    ].join('\n')
  )
  .parseAsync();
