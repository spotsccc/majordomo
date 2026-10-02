import { unwrap } from "@spotsccc/error-as-value";
import { describe, expect, it } from "vitest";
import {
  DeviceLoginUnavailableError,
  MemoryCredentialStore,
  OpenAISubscriptionAuth,
  beginDeviceLogin,
  pollDeviceLogin,
  startBrowserLogin,
  startDeviceLogin,
} from "../src/index.js";
import { normalizeCallbackUrl } from "../src/login.js";
import { accessToken, json } from "./helpers.js";

const tokens = () =>
  json(200, {
    id_token: "id",
    access_token: accessToken({ expiresAt: Date.now() + 3_600_000 }),
    refresh_token: "rt-login",
    expires_in: 3600,
  });

describe("startDeviceLogin", () => {
  it("waits for the user to confirm the code and saves the credential", async () => {
    let polls = 0;
    const exchanges: URLSearchParams[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/accounts/deviceauth/usercode")) {
        return json(200, {
          device_auth_id: "dev_1",
          user_code: "ABCD-1234",
          interval: "1",
        });
      }
      if (url.endsWith("/api/accounts/deviceauth/token")) {
        polls += 1;
        return polls < 2
          ? json(403, { error: "authorization_pending" })
          : json(200, {
              authorization_code: "code_1",
              code_verifier: "verifier_1",
              code_challenge: "c",
            });
      }
      if (url.endsWith("/oauth/token")) {
        exchanges.push(new URLSearchParams(String(init?.body)));
        return tokens();
      }
      throw new Error(`unexpected request to ${url}`);
    };
    const store = new MemoryCredentialStore();
    const auth = new OpenAISubscriptionAuth({ store, fetchFn });

    const session = unwrap(await startDeviceLogin(auth));
    expect(session).toMatchObject({
      userCode: "ABCD-1234",
      verificationUrl: "https://auth.openai.com/codex/device",
    });

    expect(await session.result).toMatchObject({ state: "active" });
    expect(polls).toBe(2);
    expect(exchanges[0]?.get("redirect_uri")).toBe(
      "https://auth.openai.com/deviceauth/callback",
    );
    expect(unwrap(await store.load()).credential?.refreshToken).toBe(
      "rt-login",
    );
  });

  it("reports when device login is disabled for the account", async () => {
    const auth = new OpenAISubscriptionAuth({
      store: new MemoryCredentialStore(),
      fetchFn: async () => json(404, {}),
    });
    expect(await startDeviceLogin(auth)).toBeInstanceOf(
      DeviceLoginUnavailableError,
    );
  });
});

describe("pollDeviceLogin", () => {
  it("completes once even if two status requests see the approval", async () => {
    let exchanges = 0;
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/usercode"))
        return json(200, { device_auth_id: "dev_1", user_code: "ABCD-1234" });
      if (url.endsWith("/deviceauth/token"))
        return json(200, { authorization_code: "code_1", code_verifier: "v" });
      exchanges += 1;
      // The authorization code works only once.
      return exchanges === 1 ? tokens() : json(400, { error: "invalid_grant" });
    };
    const store = new MemoryCredentialStore();
    const auth = new OpenAISubscriptionAuth({ store, fetchFn });
    const pending = unwrap(await beginDeviceLogin(auth));

    const first = await pollDeviceLogin(auth, pending);
    const second = await pollDeviceLogin(auth, pending);

    expect(first).toMatchObject({ status: "complete" });
    expect(second).toMatchObject({ status: "complete" });
    expect(unwrap(await store.load()).generation).toBe(1);
  });

  it("reports an expired code without calling OpenAI", async () => {
    const auth = new OpenAISubscriptionAuth({
      store: new MemoryCredentialStore(),
      fetchFn: async () => {
        throw new Error("unexpected request");
      },
    });
    const poll = await pollDeviceLogin(auth, {
      deviceAuthId: "dev_1",
      userCode: "ABCD-1234",
      verificationUrl: "https://auth.openai.com/codex/device",
      expiresAt: Date.now() - 1,
      pollIntervalMs: 5000,
    });
    expect(poll).toEqual({ status: "expired" });
  });
});

describe("startBrowserLogin", () => {
  it("accepts the callback URL pasted without a scheme", async () => {
    const store = new MemoryCredentialStore();
    const auth = new OpenAISubscriptionAuth({
      store,
      fetchFn: async () => tokens(),
    });
    const session = startBrowserLogin(auth);
    const state = new URL(session.authorizationUrl).searchParams.get("state");

    await session.complete(
      `localhost:1455/auth/callback?code=abc&state=${state}`,
    );

    expect(unwrap(await store.load()).credential?.refreshToken).toBe(
      "rt-login",
    );
  });

  it("normalizes the pasted callback", () => {
    const redirect = "http://localhost:1455/auth/callback";
    expect(
      normalizeCallbackUrl(
        " http://localhost:1455/auth/callback?code=1 ",
        redirect,
      ),
    ).toBe(`${redirect}?code=1`);
    expect(normalizeCallbackUrl("code=1&state=2", redirect)).toBe(
      `${redirect}?code=1&state=2`,
    );
    expect(normalizeCallbackUrl("?code=1", redirect)).toBe(
      `${redirect}?code=1`,
    );
  });
});
