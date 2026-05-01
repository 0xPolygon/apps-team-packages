/**
 * RuleTester-based unit tests for `polygon/no-discarded-typed-registry-chain`.
 *
 * The rule is type-aware (it has to look up the receiver's TS symbol
 * name), so the tester is configured with `projectService` pointing at a
 * fixtures tsconfig. Each test case includes a stub `class TypedRegistry`
 * with chainable methods that match the real package's runtime shape — the
 * rule keys on the symbol name, not the import source, so the stub is
 * sufficient to drive the type checker.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RuleTester } from '@typescript-eslint/rule-tester';
import { afterAll, describe, it } from 'vitest';

import { noDiscardedChain } from '../src/rules/no-discarded-typed-registry-chain.ts';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const __dirname = dirname(fileURLToPath(import.meta.url));

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: {
      projectService: {
        allowDefaultProject: ['*.ts'],
        defaultProject: 'tsconfig.json'
      },
      tsconfigRootDir: resolve(__dirname, 'fixtures')
    }
  }
});

const STUB = `
declare class TypedRegistry<Ops = {}, Schemes = {}> {
  registerPath<const O extends { operationId: string }>(route: O): TypedRegistry<Ops, Schemes>;
  registerSecurityScheme<const N extends string>(name: N, scheme: { type: string }): TypedRegistry<Ops, Schemes>;
  registerComponent(kind: string, name: string, value: unknown): this;
  registerWebhook(webhook: unknown): this;
  with<R>(fn: (r: this) => R): this & R;
  register<T>(refId: string, schema: T): T;
  registerParameter<T>(refId: string, schema: T): T;
}
`;

ruleTester.run('no-discarded-typed-registry-chain', noDiscardedChain, {
  valid: [
    // Chained returns — the standard correct usage.
    {
      code: `${STUB}
        const r = new TypedRegistry()
          .registerPath({ operationId: 'a' })
          .registerPath({ operationId: 'b' });
        void r;
      `
    },
    // Captured via assignment.
    {
      code: `${STUB}
        const r0 = new TypedRegistry();
        const r1 = r0.registerPath({ operationId: 'a' });
        void r1;
      `
    },
    // Returned from a function.
    {
      code: `${STUB}
        function build() {
          return new TypedRegistry().registerPath({ operationId: 'a' });
        }
        void build;
      `
    },
    // Imperative reassignment is a valid capture.
    {
      code: `${STUB}
        let r: TypedRegistry = new TypedRegistry();
        r = r.registerPath({ operationId: 'a' });
        if (true) r = r.registerPath({ operationId: 'b' });
        void r;
      `
    },
    // .with(fn) chained off the construction.
    {
      code: `${STUB}
        const helper = (r: TypedRegistry) => r.registerPath({ operationId: 'x' });
        const r = new TypedRegistry().with(helper);
        void r;
      `
    },
    // registerComponent / registerWebhook / register / registerParameter
    // are NOT in the flagged set — discarding is allowed.
    {
      code: `${STUB}
        const r = new TypedRegistry();
        r.registerComponent('schemas', 'Foo', {});
        r.registerWebhook({});
        r.register('Foo', {});
        r.registerParameter('cursor', {});
        void r;
      `
    },
    // Non-TypedRegistry receiver with a same-named method is not flagged.
    {
      code: `
        class OtherThing {
          registerPath(x: { operationId: string }): OtherThing { return this; }
        }
        const o = new OtherThing();
        o.registerPath({ operationId: 'a' });
        void o;
      `
    },
    // void-prefixed call is an explicit opt-in to discarding (escape hatch).
    {
      code: `${STUB}
        const r: TypedRegistry = new TypedRegistry();
        void r.registerPath({ operationId: 'a' });
      `
    }
  ],
  invalid: [
    // Single discarded registerPath in expression-statement position.
    {
      code: `${STUB}
        const r: TypedRegistry = new TypedRegistry();
        r.registerPath({ operationId: 'a' });
      `,
      errors: [{ messageId: 'discarded', data: { name: 'registerPath' } }]
    },
    // Two discarded registerPath calls — both flagged.
    {
      code: `${STUB}
        const r: TypedRegistry = new TypedRegistry();
        r.registerPath({ operationId: 'a' });
        r.registerPath({ operationId: 'b' });
      `,
      errors: [
        { messageId: 'discarded', data: { name: 'registerPath' } },
        { messageId: 'discarded', data: { name: 'registerPath' } }
      ]
    },
    // Discarded chain return — the outer call's return is dropped, even
    // though the inner one is captured by the chain.
    {
      code: `${STUB}
        const r: TypedRegistry = new TypedRegistry();
        r.registerPath({ operationId: 'a' }).registerPath({ operationId: 'b' });
      `,
      errors: [{ messageId: 'discarded', data: { name: 'registerPath' } }]
    },
    // registerSecurityScheme is also flagged.
    {
      code: `${STUB}
        const r: TypedRegistry = new TypedRegistry();
        r.registerSecurityScheme('apiKey', { type: 'apiKey' });
      `,
      errors: [{ messageId: 'discarded', data: { name: 'registerSecurityScheme' } }]
    },
    // .with(fn) is flagged when discarded.
    {
      code: `${STUB}
        const helper = (r: TypedRegistry) => r.registerPath({ operationId: 'x' });
        const r: TypedRegistry = new TypedRegistry();
        r.with(helper);
      `,
      errors: [{ messageId: 'discarded', data: { name: 'with' } }]
    },
    // Inside a function body — same flag.
    {
      code: `${STUB}
        function build(r: TypedRegistry) {
          r.registerPath({ operationId: 'a' });
          return r;
        }
        void build;
      `,
      errors: [{ messageId: 'discarded', data: { name: 'registerPath' } }]
    }
  ]
});
