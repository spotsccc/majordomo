import { createTaggedError } from "@spotsccc/error-as-value";
import { APICallError } from "ai";
import { AgentErrorCode } from "./agent-errors";

/** The ChatGPT subscription session is missing or dead: the owner logs in to Codex again. */
export class CodexSubscriptionError extends createTaggedError({
  name: "CodexSubscriptionError",
  message: "Нужно заново войти в Codex.",
}) {}

/** The server rejected the owner token (401): the owner enters it again. */
export class OwnerTokenError extends createTaggedError({
  name: "OwnerTokenError",
  message: "Токен не подошёл. Введите его заново.",
}) {}

/**
 * The server refused the request itself (a 4xx other than 401 and 429):
 * resending it changes nothing, so the UI offers no retry. The status is in
 * the message because the owner is also the developer.
 */
export class RequestRejectedError extends createTaggedError({
  name: "RequestRejectedError",
  message: "Сервер не принял запрос ($status).",
}) {}

/** Any other failure: the model, a 5xx or 429, the network. A retry may help. */
export class UnknownClientError extends createTaggedError({
  name: "UnknownClientError",
  message: "Не получилось получить ответ. Попробуйте ещё раз.",
}) {}

/** A chat failure the UI handles; `message` is safe to show, the original error is the `cause`. */
export type ClientError =
  | CodexSubscriptionError
  | OwnerTokenError
  | RequestRejectedError
  | UnknownClientError;

/**
 * Turns a chat error (`useChat` `onError`, `chat.error`) into a `ClientError`;
 * no error gives `undefined`. Two channels reach the client. An HTTP error
 * before the stream arrives as `APICallError`; only its status is used,
 * because its message is the raw response body. A stream error arrives as
 * `Error(errorText)` holding an `AgentErrorCode`. Anything else (a network
 * `TypeError`, an SDK error) becomes `UnknownClientError`.
 */
export function toClientError(
  error: Error | undefined,
): ClientError | undefined {
  if (!error) return undefined;

  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    if (status === 401) return new OwnerTokenError({ cause: error });
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
