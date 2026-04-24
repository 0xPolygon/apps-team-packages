import type { Hex } from 'viem';

import { isEip7702Delegation } from './eip7702.ts';

export interface GetCodeClient {
  getCode: (args: { address: Hex }) => Promise<Hex | undefined>;
}

export interface DetectSmartWalletArgs {
  client: GetCodeClient;
  address: Hex;
}

/**
 * EIP-7702 accounts have bytecode but behave like EOAs for transaction
 * submission, so they are excluded from SCW UX.
 */
export const detectSmartWallet = async ({
  client,
  address
}: DetectSmartWalletArgs): Promise<boolean> => {
  const code = await client.getCode({ address });
  if (!code || code === '0x') return false;
  if (isEip7702Delegation(code)) return false;
  return true;
};
