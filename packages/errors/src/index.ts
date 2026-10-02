export class AppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class APIError extends AppError {
  statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

export class APINotFoundError extends APIError {
  constructor(resource: string) {
    super(`${resource} не найден`, 404);
  }
}

interface NotFoundErrorParams {
  entity: string;
  id?: string;
}

export class NotFoundError extends AppError {
  readonly entity: string;
  readonly id?: string;

  constructor(params: NotFoundErrorParams);
  constructor(entity: string, id?: string);
  constructor(entityOrParams: NotFoundErrorParams | string, id?: string) {
    const params =
      typeof entityOrParams === "string"
        ? {
            entity: entityOrParams,
            id,
          }
        : entityOrParams;

    const suffix = params.id ? `: ${params.id}` : "";

    super(`${params.entity} не найден${suffix}`);
    this.entity = params.entity;
    this.id = params.id;
  }
}

export class ValidationError extends AppError {}

interface AlreadyExistsErrorParams {
  entity: string;
  id?: string;
}

export class AlreadyExistsError extends AppError {
  readonly entity: string;
  readonly id?: string;

  constructor(params: AlreadyExistsErrorParams);
  constructor(entity: string, id?: string);
  constructor(entityOrParams: AlreadyExistsErrorParams | string, id?: string) {
    const params =
      typeof entityOrParams === "string"
        ? {
            entity: entityOrParams,
            id,
          }
        : entityOrParams;

    const suffix = params.id ? `: ${params.id}` : "";

    super(`${params.entity} уже существует${suffix}`);
    this.entity = params.entity;
    this.id = params.id;
  }
}
