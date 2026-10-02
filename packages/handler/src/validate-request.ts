import { type NextRequest } from "next/server";
import { type output, type ZodType } from "zod";
import { BadRequestError } from "./errors.ts";

type RequestSchema = ZodType;
type OptionalRequestSchema = RequestSchema | undefined;
type RouteParams = Record<string, string | string[] | undefined>;

export interface ValidateRequestOptions {
  params?: RouteParams | Promise<RouteParams>;
}

export interface RequestValidationSchemas<
  TParamsSchema extends OptionalRequestSchema = undefined,
  TQuerySchema extends OptionalRequestSchema = undefined,
  TBodySchema extends OptionalRequestSchema = undefined,
> {
  params?: TParamsSchema;
  query?: TQuerySchema;
  body?: TBodySchema;
}

type SchemaOutput<TSchema extends OptionalRequestSchema> =
  TSchema extends RequestSchema ? output<TSchema> : undefined;

export interface ValidatedRequest<
  TParamsSchema extends OptionalRequestSchema = undefined,
  TQuerySchema extends OptionalRequestSchema = undefined,
  TBodySchema extends OptionalRequestSchema = undefined,
> {
  params: SchemaOutput<TParamsSchema>;
  query: SchemaOutput<TQuerySchema>;
  body: SchemaOutput<TBodySchema>;
}

function searchParamsToObject(
  searchParams: URLSearchParams,
): Record<string, string | string[]> {
  const values: Record<string, string | string[]> = {};

  for (const [key, value] of searchParams.entries()) {
    const currentValue = values[key];

    if (currentValue === undefined) {
      values[key] = value;
      continue;
    }

    if (Array.isArray(currentValue)) {
      currentValue.push(value);
      continue;
    }

    values[key] = [currentValue, value];
  }

  return values;
}

function parseWithSchema<TSchema extends RequestSchema>(
  schema: TSchema,
  value: unknown,
  errorMessage: string,
): output<TSchema> {
  const result = schema.safeParse(value);

  if (result.success) {
    return result.data;
  }

  throw new BadRequestError({
    message: errorMessage,
    details: result.error.issues,
  });
}

async function readJsonBody(request: NextRequest | Request): Promise<unknown> {
  const rawBody = await request.text();

  if (rawBody === "") {
    return undefined;
  }

  try {
    return JSON.parse(rawBody) as unknown;
  } catch (cause) {
    throw new BadRequestError({
      message: "Некорректное JSON тело запроса",
      cause,
    });
  }
}

export async function validateRequest<
  TParamsSchema extends OptionalRequestSchema = undefined,
  TQuerySchema extends OptionalRequestSchema = undefined,
  TBodySchema extends OptionalRequestSchema = undefined,
>(
  request: NextRequest | Request,
  schemas: RequestValidationSchemas<TParamsSchema, TQuerySchema, TBodySchema>,
  options: ValidateRequestOptions = {},
): Promise<ValidatedRequest<TParamsSchema, TQuerySchema, TBodySchema>> {
  const params = schemas.params
    ? parseWithSchema(
        schemas.params,
        options.params === undefined ? undefined : await options.params,
        "Ошибка валидации route параметров",
      )
    : undefined;

  const query = schemas.query
    ? parseWithSchema(
        schemas.query,
        searchParamsToObject(new URL(request.url).searchParams),
        "Ошибка валидации query параметров",
      )
    : undefined;

  const body = schemas.body
    ? parseWithSchema(
        schemas.body,
        await readJsonBody(request),
        "Ошибка валидации тела запроса",
      )
    : undefined;

  return {
    params,
    query,
    body,
  } as ValidatedRequest<TParamsSchema, TQuerySchema, TBodySchema>;
}
