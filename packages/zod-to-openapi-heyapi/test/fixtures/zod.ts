// Side-effecting re-export of Zod with the openapi extension applied.
//
// Zod v4 detail: extendZodWithOpenApi patches ZodType.prototype.openapi, but
// schemas built BEFORE the patch never pick the method up — Zod v4 wires
// methods onto subclass prototypes at construction time rather than relying
// on the prototype chain. Importing zod here, calling extendZodWithOpenApi,
// then re-exporting it gives us a single import everything else can use
// without each module having to remember the ordering rule.

import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

export { z };
