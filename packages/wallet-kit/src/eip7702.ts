import type { Hex } from 'viem';

export const EIP7702_BYTECODE_PREFIX = '0xef0100' satisfies Hex;

export const isEip7702Delegation = (bytecode: Hex | undefined | null): boolean => {
  if (!bytecode || bytecode === '0x') return false;
  return bytecode.toLowerCase().startsWith(EIP7702_BYTECODE_PREFIX);
};
