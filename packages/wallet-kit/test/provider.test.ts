import { describe, expect, it, vi } from 'vitest';

import { enableWalletTransactionForSend } from '../src/provider.tsx';

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
