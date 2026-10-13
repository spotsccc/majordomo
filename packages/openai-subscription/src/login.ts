import {
  abortableSleep,
  beginOpenAIBrowserAuthorization,
  exchangeOpenAIBrowserAuthorization,
  exchangeOpenAIDeviceAuthorization,
  pollOpenAIDeviceAuthorization,
  requestOpenAIDeviceAuthorization,
} from "@fieldwork-ai/codex-transport";
import { tryAsync, tryFn } from "@spotsccc/error-as-value";
import type { AuthStatus, OpenAISubscriptionAuth } from "./auth.js";
import { DeviceLoginUnavailableError } from "./errors.js";

/** Keep it on the server: whoever holds it can collect the tokens once the user approves. */
export interface PendingDeviceLogin {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  pollIntervalMs: number;
}

export type DeviceLoginPoll =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "complete"; auth: AuthStatus };

/**
 * `beginDeviceLogin` and `pollDeviceLogin` hold no state in memory, so they work across
 * serverless invocations.
 */
export async function beginDeviceLogin(
  auth: OpenAISubscriptionAuth,
  options: { signal?: AbortSignal } = {},
): Promise<DeviceLoginUnavailableError | Error | PendingDeviceLogin> {
  const device = await tryAsync(
    () =>
      requestOpenAIDeviceAuthorization({
        attribution: auth.attribution,
        fetchFn: auth.fetchFn,
        signal: options.signal,
      }),
    (error) =>
      /device login is not enabled/i.test(error.message)
        ? new DeviceLoginUnavailableError({ cause: error })
        : error,
  );
  if (device instanceof Error) return device;

  return { ...device };
}

/**
 * A network failure counts as pending, so a hiccup while the user types the code does not abort
 * the login. A save that loses a race to another poller (the code works once) returns that
 * poller's session.
 */
export async function pollDeviceLogin(
  auth: OpenAISubscriptionAuth,
  pending: PendingDeviceLogin,
  options: { signal?: AbortSignal } = {},
): Promise<Error | DeviceLoginPoll> {
  if (Date.now() >= pending.expiresAt) return { status: "expired" };
  const client = {
    attribution: auth.attribution,
    fetchFn: auth.fetchFn,
    signal: options.signal,
  };
  const poll = await tryAsync(
    () => pollOpenAIDeviceAuthorization(pending, client),
    (error) => error,
  );
  if (poll instanceof Error) {
    if (options.signal?.aborted || !isNetworkError(poll)) return poll;
    return { status: "pending" };
  }
  if (poll.status === "pending") return { status: "pending" };

  const credential = await tryAsync(
    () => exchangeOpenAIDeviceAuthorization(poll, client),
    (error) => error,
  );
  const saved =
    credential instanceof Error ? credential : await auth.saveLogin(credential);
  if (!(saved instanceof Error)) return { status: "complete", auth: saved };

  const status = await auth.status();
  if (
    !(status instanceof Error) &&
    status.state === "active" &&
    status.refreshedAt !== null &&
    Date.now() - status.refreshedAt < RACE_WINDOW_MS
  ) {
    return { status: "complete", auth: status };
  }
  return saved;
}

const RACE_WINDOW_MS = 60_000;

export interface DeviceLoginSession {
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  result: Promise<Error | AuthStatus>;
  cancel(): void;
}

/** `result` never causes an unhandled rejection, so it can be awaited later. */
export async function startDeviceLogin(
  auth: OpenAISubscriptionAuth,
  options: { signal?: AbortSignal } = {},
): Promise<DeviceLoginUnavailableError | Error | DeviceLoginSession> {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const pending = await beginDeviceLogin(auth, { signal });
  if (pending instanceof Error) return pending;

  const result = (async (): Promise<Error | AuthStatus> => {
    while (true) {
      const aborted = tryFn(
        () => signal.throwIfAborted(),
        (error) => error,
      );
      if (aborted instanceof Error) return aborted;

      const poll = await pollDeviceLogin(auth, pending, { signal });
      if (poll instanceof Error) return poll;
      if (poll.status === "complete") return poll.auth;
      if (poll.status === "expired") {
        return new Error(
          "Код устройства истёк, не дождавшись подтверждения. Запустите вход заново.",
        );
      }

      const slept = await tryAsync(
        () =>
          abortableSleep(
            Math.min(
              pending.pollIntervalMs,
              Math.max(0, pending.expiresAt - Date.now()),
            ),
            signal,
          ),
        (error) => error,
      );
      if (slept instanceof Error) return slept;
    }
  })();
  result.catch(() => {});

  return {
    userCode: pending.userCode,
    verificationUrl: pending.verificationUrl,
    expiresAt: pending.expiresAt,
    result,
    cancel: () => controller.abort(new Error("Вход отменён")),
  };
}

export interface BrowserLoginSession {
  authorizationUrl: string;
  /**
   * On a remote server the redirect page fails to load (it points to localhost:1455), which is
   * expected: pass the URL from the address bar.
   */
  complete(callbackUrl: string): Promise<Error | AuthStatus>;
}

export function startBrowserLogin(
  auth: OpenAISubscriptionAuth,
): BrowserLoginSession {
  const authorization = beginOpenAIBrowserAuthorization({
    attribution: auth.attribution,
  });
  return {
    authorizationUrl: authorization.authorizationUrl,
    async complete(callbackUrl) {
      const credential = await tryAsync(
        () =>
          exchangeOpenAIBrowserAuthorization(
            authorization,
            normalizeCallbackUrl(callbackUrl, authorization.redirectUri),
            { attribution: auth.attribution, fetchFn: auth.fetchFn },
          ),
        (error) => error,
      );
      if (credential instanceof Error) return credential;

      return auth.saveLogin(credential);
    },
  };
}

function isNetworkError(error: Error): boolean {
  return /OAuth request (failed|timed out)/.test(error.message);
}

export function normalizeCallbackUrl(
  input: string,
  redirectUri: string,
): string {
  const value = input.trim();
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("?") || /^(code|state)=/.test(value))
    return `${redirectUri}?${value.replace(/^\?/, "")}`;
  return `http://${value}`;
}
