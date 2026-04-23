import { describe, expect, it } from 'vitest';

import { BadRequest, NotFound, VError, WError } from '@polygonlabs/verror';

import { sanitiseEthersFetchError } from '../src/index.ts';

function buildV6Error(secret = 'SECRET'): Error {
  return Object.assign(
    new Error(
      `server response 401 Unauthorized (info={ "requestUrl": "http://host/?token=${secret}" })`
    ),
    {
      shortMessage: 'server response 401 Unauthorized',
      code: 'SERVER_ERROR',
      info: { requestUrl: `http://host/?token=${secret}`, responseStatus: '401 Unauthorized' }
    }
  );
}

function buildV5Error(secret = 'SECRET'): Error {
  return Object.assign(
    new Error(
      `bad response (status=401, url="https://host.example/?token=${secret}", code=SERVER_ERROR, version=5.8.0)`
    ),
    {
      code: 'SERVER_ERROR',
      reason: 'bad response',
      url: `https://host.example/?token=${secret}`,
      status: 401,
      body: '{"error":"unauthorized"}'
    }
  );
}

describe('sanitiseEthersFetchError — non-ethers inputs', () => {
  it('returns null for a plain Error', () => {
    expect(sanitiseEthersFetchError(new Error('boom'))).equal(null);
  });

  it('returns null for an HTTPError subclass (no info.requestUrl)', () => {
    expect(sanitiseEthersFetchError(new NotFound('GET /missing'))).equal(null);
    expect(sanitiseEthersFetchError(new BadRequest('bad'))).equal(null);
  });

  it('returns null for a VError with info but no requestUrl key', () => {
    const err = new VError('wrapped', { info: { txHash: '0xabc' } });
    expect(sanitiseEthersFetchError(err)).equal(null);
  });

  it('returns null for non-Error values', () => {
    expect(sanitiseEthersFetchError(undefined)).equal(null);
    expect(sanitiseEthersFetchError(null)).equal(null);
    expect(sanitiseEthersFetchError('string error')).equal(null);
    expect(sanitiseEthersFetchError({ info: { requestUrl: 'http://x' } })).equal(null);
  });

  it('returns null for a plain Error with a URL in its message but no ethers fingerprint', () => {
    // Non-ethers HTTP clients (viem, web3, custom fetch wrappers) that leak
    // URLs via `err.message` are out of scope — this sanitiser is specifically
    // for ethers fetch errors. Other library-specific leaks get their own
    // detector if and when we add support for them.
    const err = new Error('fetch failed: https://api.example/private?token=X returned 401');
    expect(sanitiseEthersFetchError(err)).equal(null);
  });

  it('returns a sanitised Error for an Error-shaped object carrying info.requestUrl', () => {
    const err = Object.assign(
      new Error('server response 401 Unauthorized (url=http://host/?token=SECRET, body=…)'),
      {
        shortMessage: 'server response 401 Unauthorized',
        info: { requestUrl: 'http://host/?token=SECRET' },
        code: 'SERVER_ERROR'
      }
    );
    const sanitised = sanitiseEthersFetchError(err) as Error & {
      info?: { requestUrl?: string };
    };
    expect(sanitised).instanceOf(Error);
    expect(sanitised.info).property('requestUrl', 'http://host');
    expect(sanitised.message).contain('server response 401 Unauthorized');
    expect(sanitised.message).not.contain('SECRET');
  });
});

describe('sanitiseEthersFetchError — ethers v5 shape', () => {
  // v5 attaches params (url, body, status, etc.) directly to the Error,
  // uses `reason` as the safe summary, and raises these codes from fetch.
  function buildV5Error(overrides?: {
    code?: string;
    reason?: string;
    url?: string;
    status?: number;
  }): Error {
    const { code = 'SERVER_ERROR', reason = 'bad response', url, status = 401 } = overrides ?? {};
    const fullUrl = url ?? 'https://host.example/?token=SECRET';
    return Object.assign(
      new Error(
        `${reason} (status=${status}, body="unauthorized", url="${fullUrl}", code=${code}, version=5.8.0)`
      ),
      {
        code,
        reason,
        url: fullUrl,
        status,
        body: '{"error":"unauthorized"}',
        responseText: '{"error":"unauthorized"}'
      }
    );
  }

  it('detects a SERVER_ERROR v5 shape and rebuilds its info', () => {
    const sanitised = sanitiseEthersFetchError(buildV5Error()) as Error & {
      info?: Record<string, unknown>;
    };
    expect(sanitised.info).property('requestUrl', 'https://host.example');
    expect(sanitised.info).property('responseStatus', 401);
    expect(sanitised.message).contain('bad response');
    expect(sanitised.message).not.contain('SECRET');
  });

  it('strips the full URL from the sanitised clone stack trace', () => {
    const err = buildV5Error();
    err.stack = `Error: bad response (url="https://host.example/?token=SECRET")\n    at rpc (/app/provider.js:10:5)`;
    const sanitised = sanitiseEthersFetchError(err);
    expect(sanitised).property('stack').a('string');
    expect(sanitised?.stack ?? '').not.contain('SECRET');
  });

  it('also detects TIMEOUT and NETWORK_ERROR codes', () => {
    expect(
      sanitiseEthersFetchError(buildV5Error({ code: 'TIMEOUT', reason: 'timeout' }))
    ).instanceOf(Error);
    expect(
      sanitiseEthersFetchError(buildV5Error({ code: 'NETWORK_ERROR', reason: 'connection failed' }))
    ).instanceOf(Error);
  });

  it('does not detect non-fetch v5 codes (e.g. CALL_EXCEPTION carries url but not from an RPC fetch failure)', () => {
    const callException = Object.assign(new Error('call revert exception'), {
      code: 'CALL_EXCEPTION',
      reason: 'call revert exception',
      url: 'https://host.example/?token=SECRET'
    });
    expect(sanitiseEthersFetchError(callException)).equal(null);
  });

  it('detects a v5 shape even when `reason` is missing from the raw error', () => {
    // The short-summary field is a response-surface concern (extracted by
    // the express handler's own walker), not a sanitiser concern. All the
    // sanitiser needs to fire is the v5 fingerprint: code + url.
    const err = Object.assign(new Error('bad response (…)'), {
      code: 'SERVER_ERROR',
      url: 'https://host.example/?token=SECRET'
    });
    expect(sanitiseEthersFetchError(err)).instanceOf(Error);
  });

  it('does not copy leaky v5 top-level fields (body, responseText, url) onto the sanitised clone', () => {
    const sanitised = sanitiseEthersFetchError(buildV5Error()) as Error & Record<string, unknown>;
    expect(sanitised).not.property('url');
    expect(sanitised).not.property('body');
    expect(sanitised).not.property('responseText');
  });
});

describe('sanitiseEthersFetchError — ethers error wrapped as VError/WError cause', () => {
  const SECRET = 'TEST_SECRET_ABC123';

  it('detects a v6 ethers error wrapped with VError — outer wrapper and cause chain are preserved', () => {
    const ethersErr = buildV6Error(SECRET);
    const wrapped = new VError('Failed to fetch block number', { cause: ethersErr });
    const sanitised = sanitiseEthersFetchError(wrapped) as Error & { cause?: unknown };

    // Outer node preserves the wrapper's context.
    expect(sanitised.message).contain('Failed to fetch block number');
    expect(JSON.stringify(sanitised)).not.contain(SECRET);
    // Inner node in the chain is the sanitised ethers clone.
    const cause = sanitised.cause as Error & { info?: { requestUrl?: string } };
    expect(cause).instanceOf(Error);
    expect(cause.info).property('requestUrl', 'http://host');
  });

  it('detects a v5 ethers error wrapped with VError — outer wrapper and cause chain are preserved', () => {
    const ethersErr = buildV5Error(SECRET);
    const wrapped = new VError('upstream RPC unreachable', { cause: ethersErr });
    const sanitised = sanitiseEthersFetchError(wrapped) as Error & { cause?: unknown };

    expect(sanitised.message).contain('upstream RPC unreachable');
    expect(JSON.stringify(sanitised)).not.contain(SECRET);
    const cause = sanitised.cause as Error & { info?: { requestUrl?: string } };
    expect(cause).instanceOf(Error);
    expect(cause.info).property('requestUrl', 'https://host.example');
  });

  it('preserves a three-level wrapping chain with sanitised ethers at the deepest level', () => {
    const ethersErr = buildV6Error(SECRET);
    const mid = new VError('mid-layer', { cause: ethersErr });
    const outer = new VError('outer boundary', { cause: mid });
    const sanitised = sanitiseEthersFetchError(outer);

    const chain: Error[] = [];
    let cur: unknown = sanitised;
    while (cur instanceof Error) {
      chain.push(cur);
      cur = (cur as { cause?: unknown }).cause;
    }
    expect(chain).property('length', 3);
    expect(chain[0]?.message).contain('outer boundary');
    expect(chain[1]?.message).contain('mid-layer');
    const ethersNode = chain[2] as Error & { info?: { requestUrl?: string } };
    expect(ethersNode.info).property('requestUrl', 'http://host');
    expect(JSON.stringify(sanitised)).not.contain(SECRET);
  });

  it('detects through a WError wrap and strips the URL from the top-level message', () => {
    const ethersErr = buildV6Error(SECRET);
    const wrapped = new WError('block-number route failed', { cause: ethersErr });
    const sanitised = sanitiseEthersFetchError(wrapped);
    expect(sanitised?.message).not.contain(SECRET);
  });

  it('defence-in-depth: strips URL from the top-level message even when VError has folded the cause into its own message', () => {
    // VError's constructor concatenates `${message}: ${cause.message}` into
    // its own .message (see `accumulateCauseMessage` in verror.ts), so the
    // token from the wrapped ethers error ends up on the outermost node
    // too. The per-node URL strip must remove it there, not just on the
    // ethers node.
    const ethersErr = buildV6Error(SECRET);
    const wrapped = new VError('Failed to fetch block number', { cause: ethersErr });
    // Sanity check: verify VError really did fold the cause message before
    // we lean on that as a test precondition. If a future VError version
    // changes this behaviour, this assertion fires and we know to reassess
    // whether the defence-in-depth strip is still load-bearing.
    expect(wrapped.message).contain(SECRET);

    const sanitised = sanitiseEthersFetchError(wrapped);
    expect(sanitised?.message).not.contain(SECRET);
  });

  it('returns null when a VError has no ethers error anywhere in its chain', () => {
    const inner = new Error('database connection reset');
    const wrapped = new VError('query failed', { cause: inner });
    expect(sanitiseEthersFetchError(wrapped)).equal(null);
  });

  it("preserves non-ethers wrapper VError's info through to the sanitised clone", () => {
    const ethersErr = buildV6Error(SECRET);
    const wrapped = new VError('Failed to fetch block number', {
      cause: ethersErr,
      info: { userId: 'user-42', operation: 'blockNumber.get' }
    });
    const sanitised = sanitiseEthersFetchError(wrapped) as Error & {
      info?: { userId?: string; operation?: string };
    };
    // VError info on the wrapper is preserved on the outer sanitised node —
    // operators keep the "what was being attempted" context.
    expect(sanitised.info).property('userId', 'user-42');
    expect(sanitised.info).property('operation', 'blockNumber.get');
  });

  it("does not duplicate stack frames across the chain (each node's stack stays independent)", () => {
    // Regression guard. VError.fullStack() is an on-demand concatenator;
    // individual err.stack is NOT auto-glued across causes. If the
    // sanitiser ever naïvely merged stacks into the outer clone's .stack,
    // pino's default err serialiser (which walks .cause and emits each
    // node's stack independently) would print the inner frames twice.
    //
    // We prove this by constructing each chain node from a uniquely-named
    // function, so each error's V8 stack has a distinguishable marker
    // frame. If VError were auto-gluing cause stacks into its own, the
    // outer's .stack would contain the inner's marker.
    const makeInnerEthers = () => buildV6Error(SECRET);
    const makeMid = (cause: Error) => new VError('mid-layer wraps ethers', { cause });
    const makeOuter = (cause: Error) => new VError('outer boundary', { cause });

    const outerSource = makeOuter(makeMid(makeInnerEthers()));

    // Sanity-check the claim on the raw (pre-sanitise) chain first: VError's
    // native .stack must not contain cause-construction frames. If this
    // assertion fires, VError has started auto-gluing stacks and the
    // sanitiser must learn to strip the duplication out of each clone.
    expect(outerSource.stack ?? '').not.contain('makeInnerEthers');
    expect(outerSource.stack ?? '').not.contain('makeMid');
    const midSource = (outerSource as { cause?: Error }).cause;
    expect(midSource?.stack ?? '').not.contain('makeInnerEthers');

    // Now verify the sanitised clones preserve that independence.
    const sanitised = sanitiseEthersFetchError(outerSource);
    const chain: Array<Error & { cause?: unknown }> = [];
    let cur: unknown = sanitised;
    while (cur instanceof Error) {
      chain.push(cur as Error & { cause?: unknown });
      cur = (cur as { cause?: unknown }).cause;
    }
    expect(chain).property('length', 3);
    expect(chain[0]?.stack ?? '').not.contain('makeInnerEthers');
    expect(chain[0]?.stack ?? '').not.contain('makeMid');
    expect(chain[1]?.stack ?? '').not.contain('makeInnerEthers');
  });
});
