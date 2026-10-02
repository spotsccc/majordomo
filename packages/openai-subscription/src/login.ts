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

/**
 * A started device login. Keep it on the server between requests (it lets its
 * holder collect the tokens once the user approves): show the browser only
 * `userCode` and `verificationUrl`.
 */
export interface PendingDeviceLogin {
  deviceAuthId: string;
  /** Code the user enters at `verificationUrl`. */
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
 * Device-code login, the main flow for a remote server: the server shows a
 * short code, the user opens the verification page on any device (a phone is
 * fine), signs in to ChatGPT and enters the code. Nothing has to reach the server
 * from the browser, so no tunnels or open ports are needed.
 *
 * `beginDeviceLogin` and `pollDeviceLogin` hold no state in memory, so they work
 * across serverless invocations: store the pending login and poll it from a
 * status endpoint. `startDeviceLogin` wraps both for long-running processes.
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

/** Checks once whether the user has entered the code; on success saves the credential. */
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
    // Network hiccups while the user is typing the code should not abort the login.
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

  // Two pollers raced for the same approval: the code works once, and the
  // other one has already saved the session.
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
  /** Code the user enters at `verificationUrl`. */
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  /** Resolves once the user has confirmed the code and the credential is saved. */
  result: Promise<Error | AuthStatus>;
  cancel(): void;
}

/** Device login that polls in the background: for the CLI and other long-running processes. */
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
  // Callers may attach handlers later; avoid an unhandled rejection in between.
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
  /** Open this in a browser on any machine. */
  authorizationUrl: string;
  /**
   * Finishes the login with the URL the browser was redirected to. On a remote
   * server that page fails to load (it points to localhost:1455), which is
   * expected: copy the URL from the address bar and pass it here.
   */
  complete(callbackUrl: string): Promise<Error | AuthStatus>;
}

/** Browser (PKCE) login with a pasted callback URL: the fallback when device login is disabled. */
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

/** Accepts the URL as copied from different browsers: with or without scheme, or just the query. */
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
