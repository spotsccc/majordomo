import { AppError } from "@repo/errors";

export class HandlerError extends AppError {
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export class BadRequestError extends HandlerError {
  constructor(message = "Некорректный запрос", details?: unknown) {
    super(400, message, details);
  }
}

export class UnauthenticatedError extends HandlerError {
  constructor(message = "Требуется аутентификация", details?: unknown) {
    super(401, message, details);
  }
}

export class ForbiddenError extends HandlerError {
  constructor(message = "Недостаточно прав", details?: unknown) {
    super(403, message, details);
  }
}

export class MissingRoleError extends ForbiddenError {
  constructor(message = "Роль пользователя не назначена", details?: unknown) {
    super(message, details);
  }
}

export class ConflictError extends HandlerError {
  constructor(message = "Конфликт данных", details?: unknown) {
    super(409, message, details);
  }
}
