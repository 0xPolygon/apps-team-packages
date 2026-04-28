// Builds a single OpenAPIRegistry and a corresponding spec with one route per
// fixture schema. Used as the input the plugin sees during tests.
//
// Critical zod-to-openapi detail: `register(name, schema)` returns a NEW
// schema instance carrying the refId metadata; the original schema does not.
// To get a `$ref` in the route's response (rather than an inline schema), the
// route must use the returned named instance. Using the original silently
// inlines the schema and the plugin never sees a name to bind a transformer
// to.

import { OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';

import * as schemas from './schemas.ts';
import { z } from './zod.ts';

interface RouteSpec {
  operationId: string;
  schemaName: keyof typeof schemas;
  schema: z.ZodType;
}

const routeSpecs: ReadonlyArray<RouteSpec> = [
  { operationId: 'getScalarString', schemaName: 'ScalarString', schema: schemas.ScalarString },
  { operationId: 'getScalarNumber', schemaName: 'ScalarNumber', schema: schemas.ScalarNumber },
  { operationId: 'getScalarBoolean', schemaName: 'ScalarBoolean', schema: schemas.ScalarBoolean },
  { operationId: 'getScalarBigInt', schemaName: 'ScalarBigInt', schema: schemas.ScalarBigInt },
  { operationId: 'getOptionalField', schemaName: 'OptionalField', schema: schemas.OptionalField },
  { operationId: 'getNullableField', schemaName: 'NullableField', schema: schemas.NullableField },
  {
    operationId: 'getOptionalNullableField',
    schemaName: 'OptionalNullableField',
    schema: schemas.OptionalNullableField
  },
  { operationId: 'getEnumField', schemaName: 'EnumField', schema: schemas.EnumField },
  { operationId: 'getLiteralField', schemaName: 'LiteralField', schema: schemas.LiteralField },
  {
    operationId: 'getUnionOfLiterals',
    schemaName: 'UnionOfLiterals',
    schema: schemas.UnionOfLiterals
  },
  {
    operationId: 'getArrayOfScalars',
    schemaName: 'ArrayOfScalars',
    schema: schemas.ArrayOfScalars
  },
  { operationId: 'getArrayOfCodecs', schemaName: 'ArrayOfCodecs', schema: schemas.ArrayOfCodecs },
  { operationId: 'getRecordField', schemaName: 'RecordField', schema: schemas.RecordField },
  { operationId: 'getNested', schemaName: 'Nested', schema: schemas.Nested },
  { operationId: 'getUnionField', schemaName: 'UnionField', schema: schemas.UnionField },
  { operationId: 'getCodecObject', schemaName: 'CodecObject', schema: schemas.CodecObject },
  { operationId: 'getComposed', schemaName: 'Composed', schema: schemas.Composed },
  {
    operationId: 'getPaginatedComposed',
    schemaName: 'PaginatedComposed',
    schema: schemas.PaginatedComposed
  },
  {
    operationId: 'getStringWithMinMax',
    schemaName: 'StringWithMinMax',
    schema: schemas.StringWithMinMax
  },
  {
    operationId: 'getNumberWithRange',
    schemaName: 'NumberWithRange',
    schema: schemas.NumberWithRange
  },
  {
    operationId: 'getArrayWithLength',
    schemaName: 'ArrayWithLength',
    schema: schemas.ArrayWithLength
  },
  {
    operationId: 'getStringWithFormat',
    schemaName: 'StringWithFormat',
    schema: schemas.StringWithFormat
  },
  { operationId: 'getRefinedField', schemaName: 'RefinedField', schema: schemas.RefinedField },
  {
    operationId: 'getConstrainedCodec',
    schemaName: 'ConstrainedCodec',
    schema: schemas.ConstrainedCodec
  },

  // Constructs the old walker emitted as `unknown` — now z.output<> handles them.
  { operationId: 'getTupleField', schemaName: 'TupleField', schema: schemas.TupleField },
  {
    operationId: 'getIntersectionField',
    schemaName: 'IntersectionField',
    schema: schemas.IntersectionField
  },
  {
    operationId: 'getDiscriminatedUnion',
    schemaName: 'DiscriminatedUnion',
    schema: schemas.DiscriminatedUnion
  },
  { operationId: 'getDateField', schemaName: 'DateField', schema: schemas.DateField },
  { operationId: 'getSetField', schemaName: 'SetField', schema: schemas.SetField },
  { operationId: 'getMapField', schemaName: 'MapField', schema: schemas.MapField },
  { operationId: 'getDefaultField', schemaName: 'DefaultField', schema: schemas.DefaultField },
  {
    operationId: 'getReadonlyArrayField',
    schemaName: 'ReadonlyArrayField',
    schema: schemas.ReadonlyArrayField
  },
  { operationId: 'getBrandedField', schemaName: 'BrandedField', schema: schemas.BrandedField }
];

export const fixtureRegistry = new OpenAPIRegistry();

// Map of schemaName → named schema instance (as returned by `register()`,
// carrying refId metadata). Routes must reference the named instance so the
// generator emits `$ref` rather than inlining the schema.
const named = new Map<string, z.ZodType>();

function registerOnce(schemaName: string, schema: z.ZodType): z.ZodType {
  const existing = named.get(schemaName);
  if (existing) return existing;
  const result = fixtureRegistry.register(schemaName, schema);
  named.set(schemaName, result);
  return result;
}

// Single-200 routes — one per fixture schema.
for (const { operationId, schemaName, schema } of routeSpecs) {
  const namedSchema = registerOnce(schemaName, schema);
  fixtureRegistry.registerPath({
    method: 'get',
    path: `/fixtures/${operationId}`,
    operationId,
    responses: {
      200: {
        description: 'ok',
        content: { 'application/json': { schema: namedSchema } }
      }
    }
  });
}

// Multi-status routes — exercise the Responses-keyed-by-status and
// Errors-keyed-by-status emit paths.
const errorBadRequest = registerOnce('BadRequestError', schemas.BadRequestError);
const errorNotFound = registerOnce('NotFoundError', schemas.NotFoundError);
const errorServer = registerOnce('ServerError', schemas.ServerError);
const successResource = registerOnce('ResourceFetched', schemas.ResourceFetched);
const successCreated = registerOnce('ResourceCreated', schemas.ResourceCreated);

// Operation with 200 + 201 (different schemas) AND 400, 404, 500 errors.
fixtureRegistry.registerPath({
  method: 'post',
  path: '/fixtures/createOrFetch',
  operationId: 'createOrFetchResource',
  responses: {
    200: {
      description: 'fetched',
      content: { 'application/json': { schema: successResource } }
    },
    201: {
      description: 'created',
      content: { 'application/json': { schema: successCreated } }
    },
    400: {
      description: 'bad request',
      content: { 'application/json': { schema: errorBadRequest } }
    },
    404: {
      description: 'not found',
      content: { 'application/json': { schema: errorNotFound } }
    },
    500: {
      description: 'server error',
      content: { 'application/json': { schema: errorServer } }
    }
  }
});

// Operation with only error responses (no 2xx) — proves Errors emit works
// even when there's nothing to wire a transformer to.
fixtureRegistry.registerPath({
  method: 'get',
  path: '/fixtures/errorsOnly',
  operationId: 'getErrorsOnly',
  responses: {
    400: {
      description: 'bad request',
      content: { 'application/json': { schema: errorBadRequest } }
    },
    500: {
      description: 'server error',
      content: { 'application/json': { schema: errorServer } }
    }
  }
});

// Operation with a registered path parameter. zod-to-openapi v8's
// OpenApiGeneratorV3 lifts the parameter's schema into both
// `components.parameters.<key>` and (deliberately, as a $ref target for the
// parameter object) `components.schemas.<key>`. The plugin's audit must NOT
// demand a Zod export under that name — the generated client never imports
// parameter schemas, only response schemas.
//
// Registered under a deliberately lower-cased key (`itemId`) so a strict
// "every name in components.schemas needs a matching export" audit would
// trip on it. The fixture exists for one reason: to prove the audit
// narrowing keeps the codegen green here.
const itemIdParam = fixtureRegistry.registerParameter(
  'itemId',
  z.string().openapi({ param: { name: 'itemId', in: 'path' }, description: 'Item identifier' })
);

fixtureRegistry.registerPath({
  method: 'get',
  path: '/fixtures/items/{itemId}',
  operationId: 'getItemWithRegisteredParam',
  request: {
    params: z.object({ itemId: itemIdParam })
  },
  responses: {
    200: {
      description: 'ok',
      content: {
        'application/json': { schema: registerOnce('ScalarString', schemas.ScalarString) }
      }
    }
  }
});

export const fixtureOperationIds = [
  ...routeSpecs.map((r) => r.operationId),
  'createOrFetchResource',
  'getErrorsOnly',
  'getItemWithRegisteredParam'
];

/** Generate the OpenAPI document for the registry. */
export function generateFixtureSpec(): object {
  return new OpenApiGeneratorV3(fixtureRegistry.definitions).generateDocument({
    openapi: '3.0.0',
    info: { title: 'fixtures', version: '0.0.0' }
  });
}

export { OpenApiGeneratorV3 };
