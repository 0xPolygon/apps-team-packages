import type { Hex } from 'viem';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createScreener } from '../src/screening.ts';

vi.mock('@polygonlabs/api-gateway-client', () => {
  return {
    client: { setConfig: vi.fn() },
    screenAddress: vi.fn()
  };
});

const ADDRESS = '0xAbabababababababababababababababababAbAb' as Hex;
const LOWER = ADDRESS.toLowerCase() as Hex;
const API_ORIGIN = 'https://gateway.example.test';

describe('createScreener', () => {
  let screenAddressMock: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const mod = await import('@polygonlabs/api-gateway-client');
    screenAddressMock = vi.mocked(mod.screenAddress);
    screenAddressMock.mockReset();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('short-circuits to false when disabled — no network call', async () => {
    const screen = createScreener({ enabled: false, apiOrigin: API_ORIGIN });
    expect(await screen(ADDRESS)).toBe(false);
    expect(screenAddressMock).not.toHaveBeenCalled();
  });

  it('lowercases the address before screening', async () => {
    screenAddressMock.mockResolvedValueOnce({
      data: { address: LOWER, blocked: true, source: 'risk' as const }
    });
    const screen = createScreener({ apiOrigin: API_ORIGIN });

    expect(await screen(ADDRESS)).toBe(true);
    expect(screenAddressMock).toHaveBeenCalledWith({ path: { address: LOWER } });
  });

  it('fails open when the gateway call rejects', async () => {
    screenAddressMock.mockRejectedValueOnce(new Error('network'));
    const onScreeningError = vi.fn();
    const screen = createScreener({ apiOrigin: API_ORIGIN }, onScreeningError);

    await expect(screen(ADDRESS)).resolves.toBe(false);
    expect(onScreeningError).toHaveBeenCalledOnce();
  });
});
