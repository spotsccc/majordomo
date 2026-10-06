import { unwrap } from "@spotsccc/error-as-value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accessToken, signIn, signOut, urlOf } from "./chatgpt.test-utils";
import { createDeviceLoginStore, createOpenAIAuth } from "./openai";
import { checkDeviceLogin, ensureDeviceLogin } from "./openai-login";

const USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const POLL_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const TOKEN_URL = "https://auth.openai.com/oauth/token";

/**
 * Replaces auth.openai.com: answers each URL with its route and returns the
 * URLs requested, in order. Other URLs fail the request.
 */
function stubOpenAI(routes: Record<string, () => Response>): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = urlOf(input);
    calls.push(url);
    const route = routes[url];
    if (!route) throw new Error(`unexpected request to ${url}`);
    return route();
  });
  return calls;
}

const userCode = () =>
  Response.json({
    device_auth_id: "dev_1",
    user_code: "ABCD-1234",
    interval: "5",
  });

describe("ensureDeviceLogin and checkDeviceLogin", () => {
  beforeEach(async () => {
    await signOut();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts one device login and hands out its code until it expires, keeping the device id on the server", async () => {
    const calls = stubOpenAI({ [USERCODE_URL]: userCode });

    const first = unwrap(await ensureDeviceLogin());
    const second = unwrap(await ensureDeviceLogin());

    expect(first).toEqual({
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
      expiresAt: expect.any(String),
      pollIntervalMs: 5000,
    });
    expect(second).toEqual(first);
    expect(calls).toEqual([USERCODE_URL]);
  });

  it("reports pending while the owner has not entered the code", async () => {
    stubOpenAI({
      [USERCODE_URL]: userCode,
      [POLL_URL]: () => Response.json({}, { status: 403 }),
    });
    unwrap(await ensureDeviceLogin());

    expect(await checkDeviceLogin()).toEqual({ state: "pending" });
    expect(unwrap(await createDeviceLoginStore().get())).not.toBeNull();
  });

  it("saves the session and drops the code once the owner has entered it", async () => {
    stubOpenAI({
      [USERCODE_URL]: userCode,
      [POLL_URL]: () =>
        Response.json({ authorization_code: "code_1", code_verifier: "v_1" }),
      [TOKEN_URL]: () =>
        Response.json({
          access_token: accessToken(Date.now() + 60 * 60_000),
          refresh_token: "rt-login",
          expires_in: 3600,
        }),
    });
    unwrap(await ensureDeviceLogin());

    expect(await checkDeviceLogin()).toEqual({ state: "complete" });
    expect(unwrap(await createOpenAIAuth().status())).toMatchObject({
      state: "active",
    });
    expect(unwrap(await createDeviceLoginStore().get())).toBeNull();
  });

  it("drops a code that OpenAI refuses, so the next request starts a fresh login", async () => {
    stubOpenAI({
      [USERCODE_URL]: userCode,
      [POLL_URL]: () => Response.json({ error: "denied" }, { status: 400 }),
    });
    unwrap(await ensureDeviceLogin());

    expect(await checkDeviceLogin()).toEqual({
      state: "failed",
      message: expect.any(String),
    });
    expect(unwrap(await createDeviceLoginStore().get())).toBeNull();
  });

  it("forgets an expired code without asking OpenAI", async () => {
    const calls = stubOpenAI({ [USERCODE_URL]: userCode });
    const prompt = unwrap(await ensureDeviceLogin());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(prompt.expiresAt) + 1);

    expect(await checkDeviceLogin()).toEqual({ state: "none" });
    expect(calls).toEqual([USERCODE_URL]);
  });

  it("without a login in progress reports complete for a saved session and none otherwise", async () => {
    expect(await checkDeviceLogin()).toEqual({ state: "none" });

    await signIn();

    expect(await checkDeviceLogin()).toEqual({ state: "complete" });
  });
});
