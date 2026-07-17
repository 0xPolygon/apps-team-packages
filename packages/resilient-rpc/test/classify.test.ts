import { describe, expect, it } from 'vitest';

import { classifyRpcError } from '../src/classify.ts';
import {
  JsonRpcResponseError,
  RpcAttemptTimeoutError,
  RpcChainIdMismatchError,
  RpcHttpStatusError,
  RpcMalformedResponseError
} from '../src/errors.ts';
import { transportError } from './helpers.ts';

const withFields = (message: string, fields: Record<string, unknown>): Error =>
  Object.assign(new Error(message), fields);

describe('transport-class (retry + failover + counts against health)', () => {
  it('classifies Node system and TLS error codes', () => {
    expect(classifyRpcError(transportError('ECONNREFUSED'))).equal('transport');
    expect(classifyRpcError(transportError('ENOTFOUND'))).equal('transport');
    expect(classifyRpcError(transportError('EAI_AGAIN'))).equal('transport');
    expect(classifyRpcError(transportError('ERR_TLS_CERT_ALTNAME_INVALID'))).equal('transport');
    expect(classifyRpcError(transportError('SELF_SIGNED_CERT_IN_CHAIN'))).equal('transport');
  });

  it('classifies HTTP 5xx/408, attempt timeouts, malformed responses and probe mismatches', () => {
    expect(classifyRpcError(new RpcHttpStatusError({ status: 503 }))).equal('transport');
    expect(classifyRpcError(new RpcHttpStatusError({ status: 408 }))).equal('transport');
    expect(classifyRpcError(new RpcAttemptTimeoutError({ timeoutMs: 10 }))).equal('transport');
    expect(classifyRpcError(new RpcMalformedResponseError())).equal('transport');
    expect(
      classifyRpcError(new RpcChainIdMismatchError({ expectedChainId: 137, actualResult: '0x1' }))
    ).equal('transport');
  });

  it('classifies JSON-RPC -32700/-32603 and viem/ethers transport shapes', () => {
    expect(
      classifyRpcError(new JsonRpcResponseError({ code: -32700, message: 'parse error' }))
    ).equal('transport');
    expect(
      classifyRpcError(new JsonRpcResponseError({ code: -32603, message: 'internal error' }))
    ).equal('transport');
    // viem
    expect(
      classifyRpcError(withFields('HTTP request failed', { name: 'HttpRequestError', status: 502 }))
    ).equal('transport');
    expect(classifyRpcError(withFields('timed out', { name: 'TimeoutError' }))).equal('transport');
    // ethers v6
    expect(classifyRpcError(withFields('server error', { code: 'SERVER_ERROR' }))).equal(
      'transport'
    );
    expect(classifyRpcError(withFields('network problem', { code: 'NETWORK_ERROR' }))).equal(
      'transport'
    );
  });

  it('walks the cause chain to find the decisive node', () => {
    const nested = new Error('fetch failed', { cause: transportError('ECONNRESET') });
    expect(classifyRpcError(nested)).equal('transport');
  });
});

describe('application-class (throws immediately; never touches health)', () => {
  it('classifies execution reverts by code and by message', () => {
    expect(classifyRpcError(withFields('execution reverted: NotOwner()', { code: 3 }))).equal(
      'application'
    );
    expect(classifyRpcError(new Error('execution reverted'))).equal('application');
    expect(classifyRpcError(withFields('call exception', { code: 'CALL_EXCEPTION' }))).equal(
      'application'
    );
  });

  it('classifies -32601/-32602 and user-rejection codes', () => {
    expect(
      classifyRpcError(new JsonRpcResponseError({ code: -32601, message: 'method not found' }))
    ).equal('application');
    expect(
      classifyRpcError(new JsonRpcResponseError({ code: -32602, message: 'invalid params' }))
    ).equal('application');
    expect(classifyRpcError(withFields('user rejected', { code: 4001 }))).equal('application');
  });

  it('classifies nonce/funds/underpriced/already-known messages', () => {
    expect(classifyRpcError(new Error('nonce too low'))).equal('application');
    expect(classifyRpcError(new Error('insufficient funds for gas * price + value'))).equal(
      'application'
    );
    expect(classifyRpcError(new Error('replacement transaction underpriced'))).equal('application');
    expect(classifyRpcError(new Error('already known'))).equal('application');
  });

  it('defaults unknown errors to application so they never poison health', () => {
    expect(classifyRpcError(new Error('something novel happened'))).equal('application');
    expect(classifyRpcError('a thrown string')).equal('application');
    expect(classifyRpcError(undefined)).equal('application');
  });
});

describe('borderline (fails over WITHOUT counting toward opening)', () => {
  it('classifies HTTP 429 and rate-limit messages', () => {
    expect(classifyRpcError(new RpcHttpStatusError({ status: 429 }))).equal('borderline');
    expect(classifyRpcError(withFields('too many requests', { status: 429 }))).equal('borderline');
    expect(classifyRpcError(new Error('rate limit exceeded'))).equal('borderline');
  });

  it('classifies endpoint-local data availability gaps', () => {
    expect(classifyRpcError(new Error('header not found'))).equal('borderline');
    expect(classifyRpcError(new Error('missing trie node deadbeef'))).equal('borderline');
    expect(
      classifyRpcError(new Error('requested block is older than the earliest available'))
    ).equal('borderline');
  });
});
