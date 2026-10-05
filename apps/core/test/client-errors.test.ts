import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import {
  CodexSubscriptionError,
  OwnerTokenError,
  RequestRejectedError,
  UnknownClientError,
  toClientError,
} from "../src/lib/client-errors";

function httpError(statusCode: number): APICallError {
  return new APICallError({
    message: '{"error":"…"}',
    url: "/api/agent",
    requestBodyValues: undefined,
    statusCode,
  });
}

describe("toClientError", () => {
  it("returns undefined when there is no error", () => {
    expect(toClientError(undefined)).toBeUndefined();
  });

  it("maps the login code from the stream to CodexSubscriptionError", () => {
    expect(toClientError(new Error("openai_login_required"))).toBeInstanceOf(
      CodexSubscriptionError,
    );
  });

  it("maps the model_failed code from the stream to UnknownClientError", () => {
    expect(toClientError(new Error("model_failed"))).toBeInstanceOf(
      UnknownClientError,
    );
  });

  it("maps a 401 response to OwnerTokenError", () => {
    expect(toClientError(httpError(401))).toBeInstanceOf(OwnerTokenError);
  });

  it("maps a 413 response to RequestRejectedError with the status in the message", () => {
    const error = toClientError(httpError(413));
    expect(error).toBeInstanceOf(RequestRejectedError);
    expect(error?.message).toBe("Сервер не принял запрос (413).");
  });

  it("maps 429 and 5xx responses to UnknownClientError", () => {
    expect(toClientError(httpError(429))).toBeInstanceOf(UnknownClientError);
    expect(toClientError(httpError(504))).toBeInstanceOf(UnknownClientError);
  });

  it("maps a network failure to UnknownClientError and keeps it as the cause", () => {
    const failure = new TypeError("Failed to fetch");
    const error = toClientError(failure);
    expect(error).toBeInstanceOf(UnknownClientError);
    expect(error?.cause).toBe(failure);
  });
});
