import {
  abortableSleep,
  beginOpenAIBrowserAuthorization,
  exchangeOpenAIBrowserAuthorization,
  exchangeOpenAIDeviceAuthorization,
  pollOpenAIDeviceAuthorization,
  requestOpenAIDeviceAuthorization,
} from "@fieldwork-ai/codex-transport";
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
): Promise<PendingDeviceLogin> {
  try {
    const device = await requestOpenAIDeviceAuthorization({
      attribution: auth.attribution,
      fetchFn: auth.fetchFn,
      signal: options.signal,
    });
    return { ...device };
  } catch (error) {
    if (
      error instanceof Error &&
      /device login is not enabled/i.test(error.message)
    ) {
      throw new DeviceLoginUnavailableError({ cause: error });
    }
    throw error;
  }
}

/** Checks once whether the user has entered the code; on success saves the credential. */
export async function pollDeviceLogin(
  auth: OpenAISubscriptionAuth,
  pending: PendingDeviceLogin,
  options: { signal?: AbortSignal } = {},
): Promise<DeviceLoginPoll> {
  if (Date.now() >= pending.expiresAt) return { status: "expired" };
  const client = {
    attribution: auth.attribution,
    fetchFn: auth.fetchFn,
    signal: options.signal,
  };
  let poll;
  try {
    poll = await pollOpenAIDeviceAuthorization(pending, client);
  } catch (error) {
    // Network hiccups while the user is typing the code should not abort the login.
    if (options.signal?.aborted || !isNetworkError(error)) throw error;
    return { status: "pending" };
  }
  if (poll.status === "pending") return { status: "pending" };
  try {
    const credential = await exchangeOpenAIDeviceAuthorization(poll, client);
    return { status: "complete", auth: await auth.saveLogin(credential) };
  } catch (error) {
    // Two pollers raced for the same approval: the code works once, and the
    // other one has already saved the session.
    const status = await auth.status();
    if (
      status.state === "active" &&
      status.refreshedAt !== null &&
      Date.now() - status.refreshedAt < RACE_WINDOW_MS
    ) {
      return { status: "complete", auth: status };
    }
    throw error;
  }
}

const RACE_WINDOW_MS = 60_000;

export interface DeviceLoginSession {
  /** Code the user enters at `verificationUrl`. */
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  /** Resolves once the user has confirmed the code and the credential is saved. */
  result: Promise<AuthStatus>;
  cancel(): void;
}

/** Device login that polls in the background: for the CLI and other long-running processes. */
export async function startDeviceLogin(
  auth: OpenAISubscriptionAuth,
  options: { signal?: AbortSignal } = {},
): Promise<DeviceLoginSession> {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const pending = await beginDeviceLogin(auth, { signal });

  const result = (async () => {
    while (true) {
      signal.throwIfAborted();
      const poll = await pollDeviceLogin(auth, pending, { signal });
      if (poll.status === "complete") return poll.auth;
      if (poll.status === "expired") {
        throw new Error(
          "Код устройства истёк, не дождавшись подтверждения. Запустите вход заново.",
        );
      }
      await abortableSleep(
        Math.min(
          pending.pollIntervalMs,
          Math.max(0, pending.expiresAt - Date.now()),
        ),
        signal,
      );
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
  complete(callbackUrl: string): Promise<AuthStatus>;
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
      const credential = await exchangeOpenAIBrowserAuthorization(
        authorization,
        normalizeCallbackUrl(callbackUrl, authorization.redirectUri),
        { attribution: auth.attribution, fetchFn: auth.fetchFn },
      );
      return auth.saveLogin(credential);
    },
  };
}

function isNetworkError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /OAuth request (failed|timed out)/.test(error.message)
  );
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
