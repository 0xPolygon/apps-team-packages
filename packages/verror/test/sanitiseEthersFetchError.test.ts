import { describe, expect, it } from 'vitest';

import { BadRequest, NotFound } from '../src/http.ts';
import { sanitiseEthersFetchError } from '../src/sanitise.ts';
import { serializeError, VError, WError } from '../src/verror.ts';

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

  it('returns null for a plain Error with a URL in its message but no library fingerprint', () => {
    // HTTP clients we have no detector for (web3, custom fetch wrappers,
    // generic node-fetch failures) that leak URLs only via `err.message`
    // are out of scope — without a structural fingerprint we can't safely
    // distinguish a leaky RPC error from a benign error that happens to
    // mention a URL. The viem and ethers detectors below cover the
    // libraries the team actually uses; add another when a new RPC
    // library shows up.
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

describe('sanitiseEthersFetchError — viem shape', () => {
  // viem `BaseError` populates `metaMessages: string[]` with lines like
  // "URL: https://…/?token=…" and "Request body: {...}", and rolls every
  // child's compound text up into each parent's `message`. The detector
  // fingerprints on `name === 'RpcRequestError' | 'HttpRequestError'` plus
  // the `metaMessages` array marker.
  function buildViemRpcRequestError(secret = 'SECRET'): Error {
    const url = `https://rpc.polygon.tools/internal/evm/1?token=${secret}`;
    const body = `{"method":"eth_estimateGas","params":[{}]}`;
    const message = `RPC Request failed.\n\nURL: ${url}\nRequest body: ${body}\n\nDetails: ...\nVersion: viem@2.38.1`;
    return Object.assign(new Error(message), {
      name: 'RpcRequestError',
      shortMessage: 'RPC Request failed.',
      metaMessages: [`URL: ${url}`, `Request body: ${body}`],
      details: 'Internal JSON-RPC error.',
      version: 'viem@2.38.1'
    });
  }

  it('detects a viem RpcRequestError and strips the URL from message and stack', () => {
    const err = buildViemRpcRequestError('TOKEN_DEEP');
    err.stack = `RpcRequestError: RPC Request failed.\n    at fetch (https://rpc.polygon.tools/internal/evm/1?token=TOKEN_DEEP)\n    at handler (/app/idle.ts:116:13)`;
    const sanitised = sanitiseEthersFetchError(err);
    expect(sanitised).instanceOf(Error);
    expect(sanitised?.message).not.contain('TOKEN_DEEP');
    expect(sanitised?.stack ?? '').not.contain('TOKEN_DEEP');
    expect(sanitised?.message).contain('RPC Request failed.');
  });

  it('does not falsely match an unrelated error class that happens to share the name', () => {
    // Without the metaMessages-array marker, the name alone is too weak a
    // fingerprint. This is a defence-in-depth guard against a stray
    // application error class colliding with viem's naming.
    const lookalike = Object.assign(new Error('not really viem'), {
      name: 'RpcRequestError'
    });
    expect(sanitiseEthersFetchError(lookalike)).equal(null);
  });

  it('detects a viem chain wrapped with VError — reproduces the rebalancer service-status leak', () => {
    // Mirrors the cause chain observed on l2-spol-rebalancer-mainnet's
    // /service-status: a VError thrown from the handler wraps a
    // ContractFunctionExecutionError that nests through several viem
    // exec errors down to the RpcRequestError carrying the token URL.
    // Every wrapping viem error echoes the URL in its own compound
    // message — defence-in-depth URL stripping must clean all of them.
    const SECRET = 'D7E70C45-4CA6-47F2-B4CF-15BB4580E927';
    const url = `https://rpc.polygon.tools/internal/evm/1?token=${SECRET}`;
    const rpcErr = buildViemRpcRequestError(SECRET);
    const innerFeeCap = Object.assign(
      new Error(
        `The fee cap (\`maxFeePerGas\` = 0.076 gwei) cannot be lower than the block base fee.\n\nURL: ${url}\nVersion: viem@2.38.1`
      ),
      {
        name: 'FeeCapTooLowError',
        cause: rpcErr,
        shortMessage:
          'The fee cap (`maxFeePerGas` = 0.076 gwei) cannot be lower than the block base fee.'
      }
    );
    const contractErr = Object.assign(
      new Error(
        `Contract Call failed.\n\nURL: ${url}\nDocs: https://viem.sh/docs/contract/writeContract\nVersion: viem@2.38.1`
      ),
      {
        name: 'ContractFunctionExecutionError',
        cause: innerFeeCap,
        shortMessage: 'Contract Call failed.'
      }
    );
    const outer = new VError('Error sending updateL2ExchangeRate transaction', {
      cause: contractErr,
      info: { operatorAddress: '0x348E8742a8B4bc6A16197bb3A9177Ad21c7e3a43' }
    });

    const sanitised = sanitiseEthersFetchError(outer);
    expect(sanitised).instanceOf(Error);
    // No node in the chain may carry the token.
    const chainJson = JSON.stringify(sanitised, (_k, v) => {
      if (v instanceof Error) {
        return {
          name: v.name,
          message: v.message,
          stack: v.stack,
          cause: (v as { cause?: unknown }).cause
        };
      }
      return v;
    });
    expect(chainJson).not.contain(SECRET);
    // The outer wrapper's info is preserved — operators still see what was attempted.
    const sanitisedInfo = (sanitised as Error & { info?: Record<string, unknown> }).info;
    expect(sanitisedInfo).property('operatorAddress', '0x348E8742a8B4bc6A16197bb3A9177Ad21c7e3a43');
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

describe('serializeError — auto-sanitises RPC fetch errors', () => {
  // The whole reason sanitiseEthersFetchError lives in @polygonlabs/verror
  // rather than @polygonlabs/logger: every persistence path that hits
  // `serializeError` must be safe by default. Logger consumers historically
  // got URL-stripping via the pino `err` serializer, but anything else that
  // serialised an error (Firestore writes for state-machine `lastError`,
  // `/service-status`-style routes returning the JSON shape directly,
  // Sentry's error capture, persisted Multi​Error errors[] arrays) had to
  // remember to call the sanitiser by hand — and didn't, which is how the
  // l2-spol-rebalancer-mainnet /service-status leak (2026-05-19) happened.
  // These tests pin the auto-sanitise behaviour into the public contract
  // of `serializeError` and `VError.toJSON` so the leak class can't recur.

  function buildV6Error(secret: string): Error {
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

  it('serializeError strips URLs when given a plain ethers v6 error', () => {
    const SECRET = 'SERIALIZE_V6_SECRET';
    const json = serializeError(buildV6Error(SECRET));
    expect(JSON.stringify(json)).not.contain(SECRET);
    // The structured `info.requestUrl` is reduced to origin so operators
    // still see *which host* the call hit, just not the token.
    const info = (json as { info?: { requestUrl?: string } }).info;
    expect(info).property('requestUrl', 'http://host');
  });

  it('serializeError strips URLs when a VError wraps the RPC failure', () => {
    const SECRET = 'SERIALIZE_VERROR_SECRET';
    const wrapped = new VError('Failed to fetch block number', {
      cause: buildV6Error(SECRET),
      info: { operatorAddress: '0xabc' }
    });
    const json = serializeError(wrapped);
    // The full nested JSON shape is URL-free.
    expect(JSON.stringify(json)).not.contain(SECRET);
    // The wrapper's `info` survives sanitisation — operators keep the
    // "what was being attempted" context even after the URL strip.
    expect((json as { info?: Record<string, unknown> }).info).property('operatorAddress', '0xabc');
    // The wrapper's shortMessage survives too rather than collapsing to
    // the full sanitised compound message.
    expect((json as { shortMessage?: string }).shortMessage).equal('Failed to fetch block number');
  });

  it('JSON.stringify(verror) is also safe — VError.toJSON sanitises on direct calls', () => {
    // Defence in depth: callers may bypass `serializeError` entirely and
    // serialise via `JSON.stringify`. The auto-sanitise on toJSON catches
    // this path too.
    const SECRET = 'JSON_STRINGIFY_SECRET';
    const wrapped = new VError('upstream RPC unreachable', { cause: buildV6Error(SECRET) });
    const stringified = JSON.stringify(wrapped);
    expect(stringified).not.contain(SECRET);
  });

  it('serializeError on a non-RPC error is unchanged (no false sanitisation)', () => {
    // A plain Error or a VError without an RPC fingerprint anywhere in the
    // chain must serialise exactly as before — the auto-sanitise hook is
    // a no-op when there's nothing to strip. Pins the "no collateral
    // damage" property: changing the canonical shape for non-RPC errors
    // would break every existing log/persist site.
    const wrapped = new VError('database connection reset', {
      info: { connectionId: 42 }
    });
    const json = serializeError(wrapped);
    expect(json).property('name', 'VError');
    expect(json).property('message', 'database connection reset');
    expect(json).property('shortMessage', 'database connection reset');
    expect((json as { info?: Record<string, unknown> }).info).property('connectionId', 42);
  });

  it('reproduces the l2-spol-rebalancer /service-status leak end-to-end', () => {
    // Exact viem chain shape observed on l2-spol-rebalancer-mainnet's
    // /service-status response: a VError thrown from the idle handler
    // wraps viem's ContractFunctionExecutionError → … → RpcRequestError
    // carrying the token URL. Pre-fix: `serializeError(err)` produced JSON
    // with the token verbatim. Post-fix: the token is gone at every
    // nesting level.
    const SECRET = 'D7E70C45-4CA6-47F2-B4CF-15BB4580E927';
    const url = `https://rpc.polygon.tools/internal/evm/1?token=${SECRET}`;
    const rpcErr = Object.assign(
      new Error(`RPC Request failed.\n\nURL: ${url}\nVersion: viem@2.38.1`),
      {
        name: 'RpcRequestError',
        shortMessage: 'RPC Request failed.',
        metaMessages: [`URL: ${url}`]
      }
    );
    const contractErr = Object.assign(
      new Error(`Contract Call failed.\n\nURL: ${url}\nVersion: viem@2.38.1`),
      {
        name: 'ContractFunctionExecutionError',
        cause: rpcErr,
        shortMessage: 'Contract Call failed.'
      }
    );
    const outer = new VError('Error sending updateL2ExchangeRate transaction', {
      cause: contractErr,
      info: { operatorAddress: '0x348E8742a8B4bc6A16197bb3A9177Ad21c7e3a43' }
    });

    const json = serializeError(outer);
    expect(JSON.stringify(json)).not.contain(SECRET);
    expect((json as { info?: Record<string, unknown> }).info).property(
      'operatorAddress',
      '0x348E8742a8B4bc6A16197bb3A9177Ad21c7e3a43'
    );
  });
});
