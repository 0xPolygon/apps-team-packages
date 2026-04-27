import { describe, expect, it, vi } from 'vitest';

import { enableWalletTransactionForSend, resolveConnectorProvider } from '../src/provider.tsx';

describe('enableWalletTransactionForSend', () => {
  it('enables Sequence wallet transaction mode when the provider supports it', async () => {
    const setUseWalletTransactionForSend = vi.fn();
    await enableWalletTransactionForSend({
      id: 'sequence-v3-wallet',
      getProvider: async () => ({ setUseWalletTransactionForSend })
    });

    expect(setUseWalletTransactionForSend).toHaveBeenCalledWith(true);
  });

  it('does nothing for providers without the Sequence send-mode hook', async () => {
    await expect(
      enableWalletTransactionForSend({
        id: 'sequence-v3-wallet',
        getProvider: async () => ({ request: async () => '0x1' })
      })
    ).resolves.toBeUndefined();
  });

  it('does not reject when provider resolution fails', async () => {
    await expect(
      enableWalletTransactionForSend({
        id: 'sequence-v3-wallet',
        getProvider: async () => {
          throw new Error('provider unavailable');
        }
      })
    ).resolves.toBeUndefined();
  });
});

describe('resolveConnectorProvider', () => {
  it('returns undefined when the connector is missing', async () => {
    expect(await resolveConnectorProvider(undefined)).toBeUndefined();
  });

  it('returns undefined when getProvider is not yet attached', async () => {
    expect(await resolveConnectorProvider({})).toBeUndefined();
  });

  it('returns undefined when getProvider throws and logs the failure by default', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(
        await resolveConnectorProvider({
          getProvider: async () => {
            throw new Error('handshake aborted');
          }
        })
      ).toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(
        '[wallet-kit] Failed to get wallet provider:',
        expect.any(Error)
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('routes failures to the onError callback when provided and skips the default log', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onError = vi.fn();
    try {
      await resolveConnectorProvider(
        {
          getProvider: async () => {
            throw new Error('handshake aborted');
          }
        },
        onError
      );
      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(expect.any(Error));
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('returns the resolved provider when getProvider succeeds', async () => {
    const fakeProvider = { request: vi.fn() };
    expect(
      await resolveConnectorProvider({
        getProvider: async () => fakeProvider
      })
    ).toBe(fakeProvider);
  });
});
