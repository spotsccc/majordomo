import {
  DeviceLoginUnavailableError,
  beginDeviceLogin,
  type NotLoggedInError,
  type ReauthRequiredError,
  pollDeviceLogin,
} from "@repo/openai-subscription";
import { createDeviceLoginStore, createOpenAIAuth } from "./openai";

/** What the client shows the owner: open the link, enter the code. */
export interface LoginPrompt {
  verificationUrl: string;
  userCode: string;
  expiresAt: string;
  /** How often to call `GET /api/openai/login` to learn the outcome. */
  pollIntervalMs: number;
}

/**
 * Returns the device login in progress, or starts one. There is at most one:
 * repeated requests reuse the code until it expires, so the owner never has
 * two codes on screen.
 */
export async function ensureDeviceLogin(): Promise<Error | LoginPrompt> {
  const deviceLogins = createDeviceLoginStore();
  if (deviceLogins instanceof Error) return deviceLogins;

  let pending = await deviceLogins.get();
  if (pending instanceof Error) return pending;
  if (!pending) {
    const auth = createOpenAIAuth();
    if (auth instanceof Error) return auth;

    const started = await beginDeviceLogin(auth);
    if (started instanceof Error) return started;

    const saved = await deviceLogins.save(started);
    if (saved instanceof Error) return saved;

    pending = started;
  }
  // deviceAuthId stays on the server: with it anyone could collect the tokens.
  return {
    verificationUrl: pending.verificationUrl,
    userCode: pending.userCode,
    expiresAt: new Date(pending.expiresAt).toISOString(),
    pollIntervalMs: pending.pollIntervalMs,
  };
}

export type LoginProgress =
  | { state: "pending" }
  | { state: "complete" }
  | { state: "none" }
  | { state: "failed"; message: string };

/** Checks once whether the owner has entered the code; finishes the login if so. */
export async function checkDeviceLogin(): Promise<Error | LoginProgress> {
  const auth = createOpenAIAuth();
  if (auth instanceof Error) return auth;

  const deviceLogins = createDeviceLoginStore();
  if (deviceLogins instanceof Error) return deviceLogins;

  const pending = await deviceLogins.get();
  if (pending instanceof Error) return pending;
  if (!pending) {
    const status = await auth.status();
    if (status instanceof Error) return status;

    return { state: status.state === "active" ? "complete" : "none" };
  }

  const poll = await pollDeviceLogin(auth, pending);
  if (poll instanceof Error) {
    // The code was denied or can no longer be exchanged: drop it, so the next
    // request starts a fresh login instead of handing out a dead code.
    const cleared = await deviceLogins.clear();
    if (cleared instanceof Error) return cleared;

    return { state: "failed", message: poll.message };
  }
  if (poll.status === "pending") return { state: "pending" };

  const cleared = await deviceLogins.clear();
  if (cleared instanceof Error) return cleared;

  return { state: poll.status === "complete" ? "complete" : "none" };
}

/**
 * The answer to any request that needs the model while there is no working
 * session: 409 with a login prompt, so the client can show it right away.
 */
export async function loginRequiredResponse(
  error: NotLoggedInError | ReauthRequiredError,
): Promise<Error | Response> {
  const login = await ensureDeviceLogin();
  if (login instanceof DeviceLoginUnavailableError) {
    return loginRequired(login.message, null);
  }
  if (login instanceof Error) return login;

  return loginRequired(error.message, login);
}

function loginRequired(message: string, login: LoginPrompt | null): Response {
  return Response.json(
    { error: "openai_login_required", message, login },
    { status: 409 },
  );
}
