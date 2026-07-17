import { describe, expect, it } from 'vitest';

import { RpcEndpointsSchema } from '../src/schema.ts';

describe('RpcEndpointsSchema', () => {
  it('parses a single URL into a one-endpoint list', () => {
    expect(RpcEndpointsSchema.parse('https://rpc-a.example/v1?token=s')).deep.equal([
      { url: 'https://rpc-a.example/v1?token=s' }
    ]);
  });

  it('parses a comma-separated list in priority order, trimming whitespace', () => {
    expect(RpcEndpointsSchema.parse('https://rpc-a.example , https://rpc-b.example')).deep.equal([
      { url: 'https://rpc-a.example' },
      { url: 'https://rpc-b.example' }
    ]);
  });

  it('parses a JSON array — string or actual array', () => {
    expect(
      RpcEndpointsSchema.parse('["https://rpc-a.example","https://rpc-b.example"]')
    ).deep.equal([{ url: 'https://rpc-a.example' }, { url: 'https://rpc-b.example' }]);
    expect(RpcEndpointsSchema.parse(['https://rpc-a.example'])).deep.equal([
      { url: 'https://rpc-a.example' }
    ]);
  });

  it('rejects empty input, empty lists and non-URL entries', () => {
    expect(RpcEndpointsSchema.safeParse('')).property('success', false);
    expect(RpcEndpointsSchema.safeParse('[]')).property('success', false);
    expect(RpcEndpointsSchema.safeParse('not-a-url')).property('success', false);
    expect(RpcEndpointsSchema.safeParse('["https://ok.example", 42]')).property('success', false);
  });
});
