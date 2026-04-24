import { describe, expect, it, vi } from 'vitest';

import type { GetCodeClient } from '../src/detect-smart-wallet.ts';

import { detectSmartWallet } from '../src/index.ts';

const TEST_ADDRESS = '0xabababababababababababababababababababab' as const;

const clientReturning = (code: `0x${string}` | undefined): GetCodeClient => ({
  getCode: vi.fn(async () => code)
});

describe('detectSmartWallet', () => {
  it('returns false when the address has no deployed code', async () => {
    expect(
      await detectSmartWallet({
        client: clientReturning('0x'),
        address: TEST_ADDRESS
      })
    ).toBe(false);
  });

  it('returns false when getCode returns undefined', async () => {
    expect(
      await detectSmartWallet({
        client: clientReturning(undefined),
        address: TEST_ADDRESS
      })
    ).toBe(false);
  });

  it('returns false for EIP-7702 delegation designators', async () => {
    expect(
      await detectSmartWallet({
        client: clientReturning('0xef0100cafebabe'),
        address: TEST_ADDRESS
      })
    ).toBe(false);
  });

  it('returns false for EIP-7702 regardless of case', async () => {
    expect(
      await detectSmartWallet({
        client: clientReturning('0xEF0100DEADBEEF'),
        address: TEST_ADDRESS
      })
    ).toBe(false);
  });

  it('returns true for real contract bytecode', async () => {
    expect(
      await detectSmartWallet({
        client: clientReturning('0x6080604052348015610010576000'),
        address: TEST_ADDRESS
      })
    ).toBe(true);
  });

  it('passes the address through unchanged to getCode', async () => {
    const client = clientReturning('0x');
    await detectSmartWallet({ client, address: TEST_ADDRESS });
    expect(client.getCode).toHaveBeenCalledWith({ address: TEST_ADDRESS });
  });
});
