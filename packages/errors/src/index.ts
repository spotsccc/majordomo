import { createTaggedError } from "@spotsccc/error-as-value";

export class NotFoundError extends createTaggedError({
  name: "NotFoundError",
  message: "$entity не найден: $id",
}) {}

export class ValidationError extends createTaggedError({
  name: "ValidationError",
}) {}
