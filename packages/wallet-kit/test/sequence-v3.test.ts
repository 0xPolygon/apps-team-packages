import { describe, expect, it } from 'vitest';

import {
  SEQUENCE_V3_CONNECTOR_ID,
  isSequenceV3Connector,
  supportsWalletTransactionForSend
} from '../src/index.ts';

describe('isSequenceV3Connector', () => {
  it('returns false for null or undefined', () => {
    expect(isSequenceV3Connector(undefined)).toBe(false);
    expect(isSequenceV3Connector(null)).toBe(false);
  });

  it('returns true when id matches exactly', () => {
    expect(isSequenceV3Connector({ id: SEQUENCE_V3_CONNECTOR_ID })).toBe(true);
  });

  it('returns false for other connector ids', () => {
    expect(isSequenceV3Connector({ id: 'metaMaskSDK' })).toBe(false);
    expect(isSequenceV3Connector({ id: 'walletConnect' })).toBe(false);
    expect(isSequenceV3Connector({ id: '' })).toBe(false);
  });

  it('does not match on substring — requires exact equality', () => {
    expect(isSequenceV3Connector({ id: 'sequence-v3-wallet-other' })).toBe(false);
    expect(isSequenceV3Connector({ id: 'prefix-sequence-v3-wallet' })).toBe(false);
  });
});

describe('supportsWalletTransactionForSend', () => {
  it('returns false for non-objects', () => {
    expect(supportsWalletTransactionForSend(null)).toBe(false);
    expect(supportsWalletTransactionForSend(undefined)).toBe(false);
    expect(supportsWalletTransactionForSend('string')).toBe(false);
    expect(supportsWalletTransactionForSend(42)).toBe(false);
  });

  it('returns false when the method is missing', () => {
    expect(supportsWalletTransactionForSend({})).toBe(false);
    expect(supportsWalletTransactionForSend({ request: () => {} })).toBe(false);
  });

  it('returns false when the property exists but is not a function', () => {
    expect(supportsWalletTransactionForSend({ setUseWalletTransactionForSend: true })).toBe(false);
    expect(supportsWalletTransactionForSend({ setUseWalletTransactionForSend: null })).toBe(false);
  });

  it('returns true when the method is a function', () => {
    const provider = { setUseWalletTransactionForSend: () => {} };
    expect(supportsWalletTransactionForSend(provider)).toBe(true);
  });

  it('narrows the type for callers', () => {
    const provider: unknown = { setUseWalletTransactionForSend: (_: boolean) => {} };
    if (supportsWalletTransactionForSend(provider)) {
      expect(() => provider.setUseWalletTransactionForSend(true)).not.toThrow();
    }
  });
});
