import { beginDeviceLogin, pollDeviceLogin } from "@repo/openai-subscription";
import { createOpenAIAuth } from "./openai";
import {
  clearDeviceLogin,
  getDeviceLogin,
  saveDeviceLogin,
} from "./openai-store";

export interface LoginPrompt {
  verificationUrl: string;
  userCode: string;
  expiresAt: string;
  pollIntervalMs: number;
}

/** `deviceAuthId` stays on the server: with it anyone could collect the tokens. */
export async function ensureDeviceLogin(): Promise<Error | LoginPrompt> {
  let pending = await getDeviceLogin();
  if (pending instanceof Error) return pending;
  if (!pending) {
    const started = await beginDeviceLogin(createOpenAIAuth());
    if (started instanceof Error) return started;

    const saved = await saveDeviceLogin(started);
    if (saved instanceof Error) return saved;

    pending = started;
  }
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

/**
 * A denied or unexchangeable code is dropped, so the next request starts a fresh login instead
 * of handing out a dead code.
 */
export async function checkDeviceLogin(): Promise<Error | LoginProgress> {
  const auth = createOpenAIAuth();
  const pending = await getDeviceLogin();
  if (pending instanceof Error) return pending;
  if (!pending) {
    const status = await auth.status();
    if (status instanceof Error) return status;

    return { state: status.state === "active" ? "complete" : "none" };
  }

  const poll = await pollDeviceLogin(auth, pending);
  if (poll instanceof Error) {
    const cleared = await clearDeviceLogin();
    if (cleared instanceof Error) return cleared;

    return { state: "failed", message: poll.message };
  }
  if (poll.status === "pending") return { state: "pending" };

  const cleared = await clearDeviceLogin();
  if (cleared instanceof Error) return cleared;

  return { state: poll.status === "complete" ? "complete" : "none" };
}
