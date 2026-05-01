/**
 * Rule: `no-discarded-chain`.
 *
 * Flags `<expr>.registerPath(...)` (and the other narrow-carrying chainable
 * methods) on a `TypedRegistry` receiver when the call appears in
 * expression-statement position — i.e. the return value is discarded.
 * The chainable API in `@polygonlabs/openapi-registry` returns a registry
 * typed with the just-registered entry added; discarding that return drops
 * the type-level narrow even though the runtime side effect (the entry is
 * recorded in `inner.definitions`) still happens. Downstream consumers
 * reading the operations manifest under-report — and `OperationsOf<F>`'s
 * empty-manifest brand only catches the worst case (every link discarded),
 * not partial discards. This rule catches partial discards at lint time.
 *
 * Type-aware: needs `parserServices` so the receiver's TypeScript symbol
 * can be inspected. The `typescript()` config in this package wires up
 * `projectService: true`, which provides what's needed.
 *
 * Only the methods whose return type carries a *type-level narrow* are
 * flagged — `registerPath`, `registerSecurityScheme`, and `with`.
 * `registerComponent` / `registerWebhook` return `this` (chainable but
 * type-level identity), and `register` / `registerParameter` return the
 * registered Zod schema (consumers commonly discard the return when they
 * just want the side effect — a schema registered for the OpenAPI spec).
 * Flagging those would produce noise.
 */

import type { TSESTree } from '@typescript-eslint/utils';
import type { Type } from 'typescript';

import { ESLintUtils } from '@typescript-eslint/utils';

const TARGET_TYPE_NAME = 'TypedRegistry';

const NARROW_CARRYING_METHODS = new Set(['registerPath', 'registerSecurityScheme', 'with']);

const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/0xPolygon/apps-team-packages/tree/main/packages/apps-team-lint/src/rules/${name}.ts`
);

export const noDiscardedChain = createRule({
  name: 'no-discarded-chain',
  meta: {
    type: 'problem',
    docs: {
      description:
        "Disallow discarding chainable returns from @polygonlabs/openapi-registry's TypedRegistry. The return carries the accumulated type-level narrow; dropping it leaves runtime registrations invisible to downstream typed handler binding."
    },
    messages: {
      discarded:
        'The return value of `{{name}}` carries the accumulated TypedRegistry type-level narrow. Capture it via chaining (`.{{name}}(...).next(...)`), assignment (`r = r.{{name}}(...)`), or by returning the chain. Discarding the return mutates the runtime registry but loses the narrow; downstream `OperationsOf<typeof buildRegistry>` will under-report.'
    },
    schema: []
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    /**
     * Recursively check whether `type` (or any constituent of a union/
     * intersection, or any base type) is named `TypedRegistry`. The receiver
     * may be typed via an alias, a constraint, or a union — pattern-matching
     * on the symbol name covers each surface that consumers actually use.
     */
    function isTypedRegistry(type: Type): boolean {
      const symbol = type.getSymbol() ?? type.aliasSymbol;
      if (symbol?.getName() === TARGET_TYPE_NAME) return true;

      // Union / intersection
      if (type.isUnionOrIntersection()) {
        return type.types.some(isTypedRegistry);
      }

      // Base classes (covers `class Foo extends TypedRegistry`)
      const baseTypes = type.getBaseTypes();
      if (baseTypes && baseTypes.some(isTypedRegistry)) return true;

      return false;
    }

    return {
      ExpressionStatement(node: TSESTree.ExpressionStatement) {
        const expr = node.expression;
        if (expr.type !== 'CallExpression') return;
        if (expr.callee.type !== 'MemberExpression') return;
        const property = expr.callee.property;
        if (property.type !== 'Identifier') return;
        const methodName = property.name;
        if (!NARROW_CARRYING_METHODS.has(methodName)) return;

        const tsNode = services.esTreeNodeToTSNodeMap.get(expr.callee.object);
        const receiverType = checker.getTypeAtLocation(tsNode);
        if (!isTypedRegistry(receiverType)) return;

        context.report({
          node: expr,
          messageId: 'discarded',
          data: { name: methodName }
        });
      }
    };
  }
});
