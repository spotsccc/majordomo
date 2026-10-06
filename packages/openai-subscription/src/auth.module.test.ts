import { unwrap } from "@spotsccc/error-as-value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAISubscriptionAuth } from "./auth.js";
import { NotLoggedInError, ReauthRequiredError } from "./errors.js";
import { credential, fakeOAuthServer } from "./oauth.test-utils.js";
import { MemoryCredentialStore } from "./store.js";

const MINUTE = 60_000;

describe("OpenAISubscriptionAuth", () => {
  it("returns a fresh credential without refreshing", async () => {
    const oauth = fakeOAuthServer();
    const saved = credential(Date.now() + 60 * MINUTE);
    const auth = new OpenAISubscriptionAuth({
      store: new MemoryCredentialStore(saved),
      fetchFn: oauth.fetch,
    });

    expect(await auth.getCredential()).toEqual(saved);
    expect(oauth.refreshCalls).toEqual([]);
  });

  it("refreshes an expiring credential and keeps the rotated refresh token", async () => {
    const oauth = fakeOAuthServer();
    const store = new MemoryCredentialStore(
      credential(Date.now() + 2 * MINUTE),
    );
    const auth = new OpenAISubscriptionAuth({ store, fetchFn: oauth.fetch });

    const refreshed = unwrap(await auth.getCredential());

    expect(oauth.refreshCalls).toEqual(["rt-0"]);
    expect(refreshed.refreshToken).toBe("rt-1");
    expect(unwrap(await store.load()).credential).toEqual(refreshed);
  });

  it("shares one refresh between concurrent callers", async () => {
    const oauth = fakeOAuthServer({ delayMs: 20 });
    const auth = new OpenAISubscriptionAuth({
      store: new MemoryCredentialStore(credential(Date.now() + MINUTE)),
      fetchFn: oauth.fetch,
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => auth.getCredential()),
    );

    expect(oauth.refreshCalls).toEqual(["rt-0"]);
    expect(
      new Set(results.map((result) => unwrap(result).accessToken)).size,
    ).toBe(1);
  });

  it("marks the session as dead after a permanent refresh failure", async () => {
    const oauth = fakeOAuthServer();
    oauth.failNextRefresh(400, {
      error: { code: "refresh_token_reused", message: "used" },
    });
    const onReauthRequired = vi.fn();
    const auth = new OpenAISubscriptionAuth({
      store: new MemoryCredentialStore(credential(Date.now() + MINUTE)),
      fetchFn: oauth.fetch,
      onReauthRequired,
    });

    expect(await auth.getCredential()).toBeInstanceOf(ReauthRequiredError);
    expect(await auth.getCredential()).toBeInstanceOf(ReauthRequiredError);

    expect(oauth.refreshCalls).toHaveLength(1);
    expect(onReauthRequired).toHaveBeenCalledTimes(1);
    expect(onReauthRequired.mock.calls[0]?.[0]).toMatchObject({
      code: "refresh_token_reused",
    });
    expect(await auth.status()).toMatchObject({ state: "reauth_required" });

    await auth.saveLogin(credential(Date.now() + 60 * MINUTE, "rt-0"));
    expect(await auth.status()).toMatchObject({
      state: "active",
      reauth: null,
      email: "owner@example.com",
    });
  });

  it("keeps using a still-valid token when the refresh fails temporarily", async () => {
    const oauth = fakeOAuthServer();
    oauth.failNextRefresh(503, { error: "temporarily_unavailable" });
    const saved = credential(Date.now() + 2 * MINUTE);
    const onError = vi.fn();
    const auth = new OpenAISubscriptionAuth({
      store: new MemoryCredentialStore(saved),
      fetchFn: oauth.fetch,
      onError,
    });

    expect(await auth.getCredential()).toEqual(saved);
    expect(onError).toHaveBeenCalledOnce();
    expect(await auth.status()).toMatchObject({ state: "active" });
  });

  it("does not refresh after a 401 if another caller already did", async () => {
    const oauth = fakeOAuthServer();
    const store = new MemoryCredentialStore(
      credential(Date.now() + 60 * MINUTE),
    );
    const auth = new OpenAISubscriptionAuth({ store, fetchFn: oauth.fetch });
    const stale = unwrap(await auth.getCredential()).accessToken;

    const first = await auth.refreshAfterUnauthorized(stale);
    const second = await auth.refreshAfterUnauthorized(stale);

    expect(oauth.refreshCalls).toEqual(["rt-0"]);
    expect(second).toEqual(first);
  });

  it("keeps a refresh that outlived its lease", async () => {
    const oauth = fakeOAuthServer({ delayMs: 50 });
    const store = new MemoryCredentialStore(credential(Date.now() + MINUTE));
    const auth = new OpenAISubscriptionAuth({
      store,
      fetchFn: oauth.fetch,
      refreshLeaseMs: 20,
    });

    const refreshed = unwrap(await auth.getCredential());

    expect(refreshed.refreshToken).toBe("rt-1");
    expect(unwrap(await store.load()).credential?.refreshToken).toBe("rt-1");
  });

  it("refreshIfDue refreshes only when the next check would be too late", async () => {
    const oauth = fakeOAuthServer();
    const auth = new OpenAISubscriptionAuth({
      store: new MemoryCredentialStore(
        credential(Date.now() + 5 * 60 * MINUTE),
      ),
      fetchFn: oauth.fetch,
    });

    expect(await auth.refreshIfDue()).toMatchObject({ state: "fresh" });
    expect(await auth.refreshIfDue({ aheadMs: 24 * 60 * MINUTE })).toEqual({
      state: "refreshed",
    });
    expect(oauth.refreshCalls).toEqual(["rt-0"]);
  });

  it("requires a login first", async () => {
    const auth = new OpenAISubscriptionAuth({
      store: new MemoryCredentialStore(),
    });
    expect(await auth.getCredential()).toBeInstanceOf(NotLoggedInError);
    expect(await auth.status()).toEqual({ state: "logged_out" });
  });
});

describe("background refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes ahead of expiry and retries temporary failures", async () => {
    const oauth = fakeOAuthServer({ lifetimeMs: 60 * MINUTE });
    oauth.failNextRefresh(503, {});
    const auth = new OpenAISubscriptionAuth({
      store: new MemoryCredentialStore(credential(Date.now() + 60 * MINUTE)),
      fetchFn: oauth.fetch,
      onError: () => {},
    });
    auth.start();

    // Nothing to do until 30 minutes before expiry.
    await vi.advanceTimersByTimeAsync(29 * MINUTE);
    expect(oauth.refreshCalls).toEqual([]);

    // First attempt fails, the retry 30 s later succeeds.
    await vi.advanceTimersByTimeAsync(1 * MINUTE + 1_000);
    expect(oauth.refreshCalls).toEqual(["rt-0"]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(oauth.refreshCalls).toEqual(["rt-0", "rt-0"]);

    // The new token lives an hour, so the next refresh is 30 minutes later.
    await vi.advanceTimersByTimeAsync(29 * MINUTE);
    expect(oauth.refreshCalls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(oauth.refreshCalls).toEqual(["rt-0", "rt-0", "rt-1"]);
    auth.stop();
  });
});
