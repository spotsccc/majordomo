import {
  DeviceLoginUnavailableError,
  NotLoggedInError,
  ReauthRequiredError,
  beginDeviceLogin,
  pollDeviceLogin,
} from "@repo/openai-subscription";
import type { Services } from "./services";

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
export async function ensureDeviceLogin({
  auth,
  deviceLogins,
}: Services): Promise<LoginPrompt> {
  let pending = await deviceLogins.get();
  if (!pending) {
    pending = await beginDeviceLogin(auth);
    await deviceLogins.save(pending);
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
export async function checkDeviceLogin({
  auth,
  deviceLogins,
}: Services): Promise<LoginProgress> {
  const pending = await deviceLogins.get();
  if (!pending) {
    const status = await auth.status();
    return { state: status.state === "active" ? "complete" : "none" };
  }
  let poll;
  try {
    poll = await pollDeviceLogin(auth, pending);
  } catch (error) {
    // The code was denied or can no longer be exchanged: drop it, so the next
    // request starts a fresh login instead of handing out a dead code.
    await deviceLogins.clear();
    return {
      state: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (poll.status === "pending") return { state: "pending" };
  await deviceLogins.clear();
  return { state: poll.status === "complete" ? "complete" : "none" };
}

/**
 * The answer to any request that needs the model while there is no working
 * session: 409 with a login prompt, so the client can show it right away.
 */
export async function loginRequiredResponse(
  services: Services,
  error: NotLoggedInError | ReauthRequiredError,
): Promise<Response> {
  let login: LoginPrompt | null = null;
  let message = error.message;
  try {
    login = await ensureDeviceLogin(services);
  } catch (loginError) {
    if (!(loginError instanceof DeviceLoginUnavailableError)) throw loginError;
    message = loginError.message;
  }
  return Response.json(
    { error: "openai_login_required", message, login },
    { status: 409 },
  );
}

export function isLoginRequired(
  error: unknown,
): error is NotLoggedInError | ReauthRequiredError {
  return (
    error instanceof NotLoggedInError || error instanceof ReauthRequiredError
  );
}
