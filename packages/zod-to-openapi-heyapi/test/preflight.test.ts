// Pre-flight check: the plugin throws a clear error when `@hey-api/sdk`
// is configured with the default `includeInEntry: true`. Without this
// guard, the failure mode is a "duplicate export" TS error in the
// downstream consumer's typecheck — opaque, far from the cause.
//
// The check itself is wired inside `registryPlugin().handler` and runs
// synchronously, but hey-api's outer pipeline catches handler errors
// and routes them through its job-error reporting machinery (which
// silences thrown errors when `logs.level: 'silent'` and may otherwise
// suppress them). To test the assertion in isolation, this file invokes
// the handler directly with a stub `PluginLike` rather than going
// through `createClient` end-to-end.

import { describe, expect, it } from 'vitest';

import { registryPlugin } from '../src/index.ts';
import { OpenApiGeneratorV3, fixtureRegistry } from './fixtures/registry.ts';

// Minimal PluginLike that lets the handler reach the pre-flight check
// before tripping on a missing call. We only care about `getPlugin`
// here — every other method is unreached because the assertion fires
// at the very top of the handler.
function makeStubPlugin(sdkConfig: Record<string, unknown> | undefined): {
  getPlugin: (name: string) => { config: Record<string, unknown> } | undefined;
} {
  const stub = {
    getPlugin(name: string) {
      if (name !== '@hey-api/sdk') return undefined;
      if (!sdkConfig) return undefined;
      return { config: sdkConfig };
    }
  };
  // Cast to any is just to satisfy the rest of the PluginLike surface
  // we don't reach.
  return stub;
}

async function buildConfig() {
  const $ = (() => undefined) as never;
  return registryPlugin({
    registry: fixtureRegistry,
    schemasFrom: '#test-fixtures/schemas',
    generatorClass: OpenApiGeneratorV3,
    $
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runHandler = (config: Awaited<ReturnType<typeof buildConfig>>, sdk: any): void => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config.handler({ plugin: makeStubPlugin(sdk) as any });
};

describe('@hey-api/sdk plugin pre-flight checks', () => {
  it('throws when includeInEntry is left at the default (true)', async () => {
    const config = await buildConfig();
    expect(() =>
      runHandler(config, { includeInEntry: true, transformer: '@polygonlabs/x' })
    ).toThrow(/'includeInEntry' must be false/);
  });

  it('throws when transformer is left at the default (false)', async () => {
    // The SDK plugin's transformer default is `false`; without it our
    // ${opId}Transformer symbols are never wired into the generated
    // SDK function, so codec response decode silently doesn't run.
    const config = await buildConfig();
    expect(() => runHandler(config, { includeInEntry: false, transformer: false })).toThrow(
      /'transformer' must be true/
    );
  });

  it('aggregates both issues when both are wrong', async () => {
    const config = await buildConfig();
    let err: unknown;
    try {
      runHandler(config, { includeInEntry: true, transformer: false });
    } catch (e) {
      err = e;
    }
    const msg = String(err);
    expect(msg).toMatch(/'includeInEntry' must be false/);
    expect(msg).toMatch(/'transformer' must be true/);
    // Copy-paste-ready before/after snippet at the bottom.
    expect(msg).toMatch(/{ name: '@hey-api\/sdk', transformer: true, includeInEntry: false }/);
  });

  it('does not throw when both keys are correct', async () => {
    const config = await buildConfig();
    // After hey-api resolveConfig, `transformer: true` is replaced with
    // the resolved transformer plugin name (a string). Either form
    // should be considered truthy here — we accept both.
    expect(() =>
      runHandler(config, {
        includeInEntry: false,
        transformer: '@polygonlabs/zod-to-openapi-heyapi'
      })
    ).not.toThrow(/must be (false|true)/);
  });

  it('does not throw when @hey-api/sdk is absent (handler proceeds, may fail elsewhere)', async () => {
    // Edge case: SDK plugin not loaded at all. The pre-flight has
    // nothing to check; later steps will fail when they try to
    // reference symbols the SDK plugin would have emitted.
    const config = await buildConfig();
    try {
      runHandler(config, undefined);
    } catch (err) {
      expect(String(err)).not.toMatch(/'includeInEntry' must be|'transformer' must be/);
    }
  });
});
