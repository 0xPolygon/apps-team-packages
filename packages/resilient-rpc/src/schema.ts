import { z } from 'zod';

import type { RpcEndpoint } from './types.ts';

/**
 * Parses an RPC-endpoints env var into a priority-ordered endpoint list.
 * Accepts, in one schema, every shape an existing single-URL env var can
 * grow into — so a service upgrades to multi-endpoint failover with a
 * secrets change, not a code change:
 *
 * - a single URL: `https://rpc-a`
 * - a comma-separated list: `https://rpc-a,https://rpc-b`
 * - a JSON array: `["https://rpc-a","https://rpc-b"]` (string or actual array)
 */
export const RpcEndpointsSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((value, ctx): string[] => {
    if (Array.isArray(value)) return value;
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'not valid JSON' });
        return z.NEVER;
      }
      if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
        ctx.addIssue({ code: 'custom', message: 'JSON value must be an array of URL strings' });
        return z.NEVER;
      }
      return parsed.filter((entry): entry is string => typeof entry === 'string');
    }
    return trimmed
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  })
  .pipe(z.array(z.url()).min(1))
  .transform((urls): RpcEndpoint[] => urls.map((url) => ({ url })));
