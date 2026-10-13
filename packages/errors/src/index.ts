import { createTaggedError } from "@spotsccc/error-as-value";

export class NotFoundError extends createTaggedError({
  name: "NotFoundError",
  message: "Не найдено: $entity $id",
}) {}

export class ValidationError extends createTaggedError({
  name: "ValidationError",
}) {}
