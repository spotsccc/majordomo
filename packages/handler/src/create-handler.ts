import { randomUUID } from "node:crypto";
import { unstable_rethrow } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";
import { type ZodType } from "zod";
import { NotFoundError, ValidationError } from "@repo/errors";
import { HandlerError } from "./errors.ts";
import { runWithHandlerRequestContext } from "./request-context.ts";
import {
  validateRequest,
  type RequestValidationSchemas,
  type ValidatedRequest,
} from "./validate-request.ts";

type RequestSchema = ZodType | undefined;
type NextRouteContext = {
  params: Promise<Record<string, string | string[] | undefined>>;
};

export interface HandlerContext<
  TParamsSchema extends RequestSchema = undefined,
  TQuerySchema extends RequestSchema = undefined,
  TBodySchema extends RequestSchema = undefined,
> extends ValidatedRequest<TParamsSchema, TQuerySchema, TBodySchema> {
  request: NextRequest;
  requestId: string;
  signal: AbortSignal;
}

/**
 * Checks a request before its params, query and body are read. Returns the
 * error to answer with (`UnauthenticatedError`, `ForbiddenError`), or
 * `undefined` to let the request through.
 */
export type Guard = (request: NextRequest) => HandlerError | undefined;

/** The validation schemas of a route and the guards that run before them. */
export interface HandlerOptions<
  TParamsSchema extends RequestSchema = undefined,
  TQuerySchema extends RequestSchema = undefined,
  TBodySchema extends RequestSchema = undefined,
> extends RequestValidationSchemas<TParamsSchema, TQuerySchema, TBodySchema> {
  /** Run in order; the first error stops the request. */
  guards?: Guard[];
}

const REQUEST_ID_HEADER = "x-request-id";
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;

function resolveRequestId(request: NextRequest): string {
  const raw = request.headers.get(REQUEST_ID_HEADER)?.trim();
  if (raw && REQUEST_ID_PATTERN.test(raw)) return raw;
  return randomUUID();
}

function toErrorBody(error: HandlerError) {
  if (error.details === undefined) {
    return { error: error.message };
  }

  return {
    error: error.message,
    details: error.details,
  };
}

function withRequestIdHeader(response: Response, requestId: string): Response {
  try {
    response.headers.set(REQUEST_ID_HEADER, requestId);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.set(REQUEST_ID_HEADER, requestId);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

function logHandlerStatus(
  requestId: string,
  status: number,
  errorClass?: string,
) {
  if (status < 400) return;

  const payload = {
    event: "route_handler_response",
    request_id: requestId,
    status,
    error_class: errorClass,
  };

  if (status >= 500) {
    console.error("[handler]", payload);
    return;
  }

  console.warn("[handler]", payload);
}

function logUnexpectedHandlerError(requestId: string, error: unknown) {
  const errorClass =
    error instanceof Error ? error.constructor.name : typeof error;
  console.error("[handler]", {
    event: "route_handler_unexpected_error",
    request_id: requestId,
    error_class: errorClass,
    error,
  });
}

/**
 * Wraps a Next.js route handler: runs `guards`, then validates params, query
 * and body against the schemas, then calls `handler`. Guards run first, so a
 * caller who is not allowed in gets 401/403, not the expected request shape.
 * Thrown `HandlerError`, `ValidationError` and `NotFoundError` become JSON
 * responses with their status; anything else is logged and answered with 500.
 * Every response carries `x-request-id`.
 */
export function createHandler<
  TParamsSchema extends RequestSchema = undefined,
  TQuerySchema extends RequestSchema = undefined,
  TBodySchema extends RequestSchema = undefined,
>(
  options: HandlerOptions<TParamsSchema, TQuerySchema, TBodySchema>,
  handler: (
    context: HandlerContext<TParamsSchema, TQuerySchema, TBodySchema>,
  ) => Promise<Response>,
) {
  return async function routeHandler(
    request: NextRequest,
    routeContext: NextRouteContext,
  ): Promise<Response> {
    const requestId = resolveRequestId(request);

    try {
      const response = await runWithHandlerRequestContext(
        { requestId },
        async () => {
          for (const guard of options.guards ?? []) {
            const denied = guard(request);
            if (denied) throw denied;
          }

          const input = await validateRequest(request, options, routeContext);

          return await handler({
            request,
            requestId,
            signal: request.signal,
            ...input,
          });
        },
      );

      logHandlerStatus(requestId, response.status);
      return withRequestIdHeader(response, requestId);
    } catch (error) {
      unstable_rethrow(error);

      if (error instanceof HandlerError) {
        logHandlerStatus(requestId, error.status, error.constructor.name);
        return withRequestIdHeader(
          NextResponse.json(toErrorBody(error), { status: error.status }),
          requestId,
        );
      }

      if (error instanceof ValidationError) {
        logHandlerStatus(requestId, 400, error.constructor.name);
        return withRequestIdHeader(
          NextResponse.json({ error: error.message }, { status: 400 }),
          requestId,
        );
      }

      if (error instanceof NotFoundError) {
        logHandlerStatus(requestId, 404, error.constructor.name);
        return withRequestIdHeader(
          NextResponse.json({ error: error.message }, { status: 404 }),
          requestId,
        );
      }

      logUnexpectedHandlerError(requestId, error);

      return withRequestIdHeader(
        NextResponse.json(
          { error: "Внутренняя ошибка сервера" },
          { status: 500 },
        ),
        requestId,
      );
    }
  };
}
