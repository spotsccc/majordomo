import { createTaggedError } from "@spotsccc/error-as-value";

/**
 * Base of errors that a route handler answers with their own status and
 * message. Tagged subclasses set `status`; `details` goes into the body.
 */
export class HandlerError extends Error {
  readonly status: number = 500;
  details?: unknown;
}

export class BadRequestError extends createTaggedError({
  name: "BadRequestError",
  extends: HandlerError,
}) {
  override readonly status = 400;

  constructor(args: { message: string; details?: unknown; cause?: unknown }) {
    super(args);
    this.details = args.details;
  }
}

export class UnauthenticatedError extends createTaggedError({
  name: "UnauthenticatedError",
  message: "Требуется аутентификация",
  extends: HandlerError,
}) {
  override readonly status = 401;
}

export class ForbiddenError extends createTaggedError({
  name: "ForbiddenError",
  message: "Недостаточно прав",
  extends: HandlerError,
}) {
  override readonly status = 403;
}

export class ConflictError extends createTaggedError({
  name: "ConflictError",
  message: "Конфликт данных",
  extends: HandlerError,
}) {
  override readonly status = 409;
}
