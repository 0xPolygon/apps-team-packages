import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { BigIntegerCodec, DecimalStringCodec, Int64Codec, IsoDateCodec } from '../src/index.ts';

describe('Int64Codec', () => {
  it('decodes an in-range digit string into a bigint', async () => {
    const value = await Int64Codec.parseAsync('42');
    expect(value).toEqual(42n);
  });

  it('round-trips through encode', async () => {
    const value = await Int64Codec.parseAsync('-123456789');
    const back = await z.encode(Int64Codec, value);
    expect(back).toEqual('-123456789');
  });

  it('rejects values above the int64 max', async () => {
    // 2^63 — one past int64 max (9223372036854775807)
    await expect(Int64Codec.parseAsync('9223372036854775808')).rejects.toThrow();
  });

  it('rejects values below the int64 min', async () => {
    // -(2^63) - 1 — one past int64 min (-9223372036854775808)
    await expect(Int64Codec.parseAsync('-9223372036854775809')).rejects.toThrow();
  });

  it('rejects non-digit strings', async () => {
    await expect(Int64Codec.parseAsync('not-a-number')).rejects.toThrow();
    await expect(Int64Codec.parseAsync('1.5')).rejects.toThrow();
    await expect(Int64Codec.parseAsync('1e10')).rejects.toThrow();
    await expect(Int64Codec.parseAsync('')).rejects.toThrow();
  });
});

describe('BigIntegerCodec', () => {
  it('parses values larger than int64', async () => {
    // Past 2^63 - 1, well into uint256 territory.
    const wei = '12345678901234567890123456789012345678901234567890';
    const value = await BigIntegerCodec.parseAsync(wei);
    expect(value).toEqual(BigInt(wei));
  });

  it('parses negative values', async () => {
    const value = await BigIntegerCodec.parseAsync('-1');
    expect(value).toEqual(-1n);
  });

  it('round-trips through encode', async () => {
    const wei = '999999999999999999999999';
    const value = await BigIntegerCodec.parseAsync(wei);
    const back = await z.encode(BigIntegerCodec, value);
    expect(back).toEqual(wei);
  });

  it('rejects non-digit strings', async () => {
    await expect(BigIntegerCodec.parseAsync('abc')).rejects.toThrow();
    await expect(BigIntegerCodec.parseAsync('1.5')).rejects.toThrow();
    await expect(BigIntegerCodec.parseAsync('')).rejects.toThrow();
  });
});

describe('DecimalStringCodec', () => {
  it('passes through integer-shaped strings', async () => {
    expect(await DecimalStringCodec.parseAsync('1500')).toEqual('1500');
  });

  it('passes through decimal-shaped strings', async () => {
    expect(await DecimalStringCodec.parseAsync('1500.50')).toEqual('1500.50');
    expect(await DecimalStringCodec.parseAsync('0.005')).toEqual('0.005');
    expect(await DecimalStringCodec.parseAsync('-0.5')).toEqual('-0.5');
  });

  it('rejects scientific notation', async () => {
    await expect(DecimalStringCodec.parseAsync('1.5e10')).rejects.toThrow();
  });

  it('rejects non-numeric strings', async () => {
    await expect(DecimalStringCodec.parseAsync('abc')).rejects.toThrow();
    await expect(DecimalStringCodec.parseAsync('.5')).rejects.toThrow();
    await expect(DecimalStringCodec.parseAsync('1.')).rejects.toThrow();
    await expect(DecimalStringCodec.parseAsync('')).rejects.toThrow();
  });

  it('round-trips through encode', async () => {
    const value = await DecimalStringCodec.parseAsync('123.456');
    const back = await z.encode(DecimalStringCodec, value);
    expect(back).toEqual('123.456');
  });
});

describe('IsoDateCodec', () => {
  it('decodes an ISO-8601 string into a Date', async () => {
    const date = await IsoDateCodec.parseAsync('2025-04-28T13:45:00Z');
    expect(date).instanceOf(Date);
    expect(date.toISOString()).toEqual('2025-04-28T13:45:00.000Z');
  });

  it('round-trips through encode', async () => {
    const date = await IsoDateCodec.parseAsync('2025-04-28T13:45:00.000Z');
    const back = await z.encode(IsoDateCodec, date);
    expect(back).toEqual('2025-04-28T13:45:00.000Z');
  });

  it('rejects malformed input', async () => {
    await expect(IsoDateCodec.parseAsync('not a date')).rejects.toThrow();
    await expect(IsoDateCodec.parseAsync('2025-04-28')).rejects.toThrow();
    await expect(IsoDateCodec.parseAsync('')).rejects.toThrow();
  });
});
