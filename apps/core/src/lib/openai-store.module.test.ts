import { randomBytes } from "node:crypto";
import { openaiCredentials, openaiDeviceLogins, SecretBox } from "@repo/db";
import {
  ReauthRequiredError,
  type OpenAISubscriptionCredential,
} from "@repo/openai-subscription";
import { unwrap } from "@spotsccc/error-as-value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_ID, accessToken, signOut, urlOf } from "./chatgpt.test-utils";
import { db } from "./db";
import { createOpenAIAuth } from "./openai";
import {
  clearDeviceLogin,
  getDeviceLogin,
  PostgresCredentialStore,
  saveDeviceLogin,
} from "./openai-store";

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const MINUTE = 60_000;

function credential(expiresAt: number): OpenAISubscriptionCredential {
  return {
    accessToken: accessToken(expiresAt),
    refreshToken: "rt-0",
    expiresAt,
    accountId: ACCOUNT_ID,
  };
}

/**
 * Replaces auth.openai.com with rotating refresh tokens, as there: each one
 * works once. With `failWith` every refresh fails with that body. Returns the
 * refresh tokens sent, in order.
 */
function stubOAuth(failWith?: unknown): string[] {
  const valid = new Set(["rt-0"]);
  const sent: string[] = [];
  let counter = 0;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url !== TOKEN_URL) throw new Error(`unexpected request to ${url}`);
      const token =
        new URLSearchParams(String(init?.body)).get("refresh_token") ?? "";
      sent.push(token);
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (failWith || !valid.delete(token)) {
        return Response.json(failWith ?? { error: "refresh_token_reused" }, {
          status: 400,
        });
      }
      counter += 1;
      valid.add(`rt-${counter}`);
      return Response.json({
        access_token: accessToken(Date.now() + 60 * MINUTE),
        refresh_token: `rt-${counter}`,
        expires_in: 3600,
      });
    },
  );
  return sent;
}

beforeEach(async () => {
  await signOut();
});

describe("PostgresCredentialStore", () => {
  it("stores the credential sealed, never in plain text", async () => {
    const saved = credential(Date.now() + 60 * MINUTE);
    unwrap(await new PostgresCredentialStore().replace(saved));

    const [row] = await db.select().from(openaiCredentials);
    expect(row?.credential).toMatch(/^v1\./);
    expect(row?.credential).not.toContain(saved.refreshToken);
    expect(
      unwrap(await new PostgresCredentialStore().load()).credential,
    ).toEqual(saved);
  });

  it("treats tokens sealed with a lost key as logged out, so a new login works", async () => {
    const lostKey = unwrap(
      SecretBox.fromKeys([randomBytes(32).toString("base64")]),
    );
    await db.update(openaiCredentials).set({
      credential: lostKey.sealJson(
        credential(Date.now() + 60 * MINUTE),
        "auth.openai_credentials:default",
      ),
    });
    const store = new PostgresCredentialStore();

    expect(await store.load()).toMatchObject({
      credential: null,
      reauth: { code: "undecryptable" },
    });

    const fresh = credential(Date.now() + 60 * MINUTE);
    unwrap(await store.replace(fresh));
    expect(unwrap(await store.load()).credential).toEqual(fresh);
  });

  it("lets only one of several instances spend the refresh token", async () => {
    unwrap(
      await new PostgresCredentialStore().replace(
        credential(Date.now() + MINUTE),
      ),
    );
    const sent = stubOAuth();
    const instances = Array.from({ length: 4 }, () => createOpenAIAuth());

    const results = await Promise.all(
      instances.map((auth) => auth.getCredential()),
    );

    expect(sent).toEqual(["rt-0"]);
    expect(
      new Set(results.map((result) => unwrap(result).refreshToken)),
    ).toEqual(new Set(["rt-1"]));
  });

  it("remembers a dead session for every instance", async () => {
    unwrap(
      await new PostgresCredentialStore().replace(
        credential(Date.now() + MINUTE),
      ),
    );
    const sent = stubOAuth({ error: "invalid_grant" });
    const first = createOpenAIAuth();
    const second = createOpenAIAuth();

    expect(await first.getCredential()).toBeInstanceOf(ReauthRequiredError);
    expect(await second.getCredential()).toBeInstanceOf(ReauthRequiredError);
    expect(sent).toHaveLength(1);
    expect(await second.status()).toMatchObject({ state: "reauth_required" });
  });
});

describe("device login", () => {
  const pending = (expiresAt: number) => ({
    deviceAuthId: "dev_secret",
    userCode: "ABCD-1234",
    verificationUrl: "https://auth.openai.com/codex/device",
    expiresAt,
    pollIntervalMs: 5000,
  });

  it("keeps the started login sealed until it is cleared", async () => {
    const started = pending(Date.now() + 15 * MINUTE);
    unwrap(await saveDeviceLogin(started));

    const [row] = await db.select().from(openaiDeviceLogins);
    expect(row?.pending).not.toContain(started.deviceAuthId);
    expect(await getDeviceLogin()).toEqual(started);

    unwrap(await clearDeviceLogin());
    expect(await getDeviceLogin()).toBeNull();
  });

  it("forgets a login whose code has expired", async () => {
    unwrap(await saveDeviceLogin(pending(Date.now() - MINUTE)));

    expect(await getDeviceLogin()).toBeNull();
  });
});
