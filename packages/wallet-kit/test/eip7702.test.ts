import { describe, expect, it } from 'vitest';

import { EIP7702_BYTECODE_PREFIX, isEip7702Delegation } from '../src/index.ts';

describe('isEip7702Delegation', () => {
  it('returns false for missing or empty bytecode', () => {
    expect(isEip7702Delegation(undefined)).toBe(false);
    expect(isEip7702Delegation('0x')).toBe(false);
  });

  it('returns true when bytecode starts with the 7702 prefix', () => {
    expect(isEip7702Delegation(`${EIP7702_BYTECODE_PREFIX}abcdef`)).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(isEip7702Delegation('0xEF0100cafebabe')).toBe(true);
  });

  it('returns false for contract bytecode without the prefix', () => {
    expect(isEip7702Delegation('0x6080604052348015610010576000')).toBe(false);
  });
});
