import { createTaggedError } from "@spotsccc/error-as-value";
import { APICallError } from "ai";
import { AgentErrorCode } from "./agent-errors";

export class CodexSubscriptionError extends createTaggedError({
  name: "CodexSubscriptionError",
  message: "Нужно заново войти в Codex.",
}) {}

export class OwnerSessionError extends createTaggedError({
  name: "OwnerSessionError",
  message: "Вход устарел. Войдите заново.",
}) {}

/** The status is in the message because the owner is also the developer. */
export class RequestRejectedError extends createTaggedError({
  name: "RequestRejectedError",
  message: "Сервер не принял запрос ($status).",
}) {}

export class UnknownClientError extends createTaggedError({
  name: "UnknownClientError",
  message: "Не получилось получить ответ. Попробуйте ещё раз.",
}) {}

export type ClientError =
  | CodexSubscriptionError
  | OwnerSessionError
  | RequestRejectedError
  | UnknownClientError;

/** Only the status of an `APICallError` is used: its message is the raw response body. */
export function toClientError(
  error: Error | undefined,
): ClientError | undefined {
  if (!error) return undefined;

  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    if (status === 401) return new OwnerSessionError({ cause: error });
    if (
      status !== undefined &&
      status >= 400 &&
      status < 500 &&
      status !== 429
    ) {
      return new RequestRejectedError({ status, cause: error });
    }
    return new UnknownClientError({ cause: error });
  }

  const code = AgentErrorCode.safeParse(error.message);
  if (code.success && code.data === "openai_login_required") {
    return new CodexSubscriptionError({ cause: error });
  }
  return new UnknownClientError({ cause: error });
}
