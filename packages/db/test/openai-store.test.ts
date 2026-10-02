import { unwrap } from "@spotsccc/error-as-value";
import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import {
  OpenAISubscriptionAuth,
  ReauthRequiredError,
  type OpenAISubscriptionCredential,
} from "@repo/openai-subscription";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import {
  PostgresCredentialStore,
  PostgresDeviceLoginStore,
  SecretBox,
  openaiCredentials,
} from "../src/index.ts";

const box = unwrap(SecretBox.fromKeys([randomBytes(32).toString("base64")]));
const MINUTE = 60_000;

let db: ReturnType<typeof drizzle>;

beforeEach(async () => {
  db = drizzle({ client: new PGlite() });
  await migrate(db, {
    migrationsFolder: new URL("../migrations", import.meta.url).pathname,
    migrationsSchema: "drizzle",
  });
});

function jwt(expiresAt: number, nonce: string): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    encode({ alg: "none" }),
    encode({
      exp: Math.floor(expiresAt / 1000),
      nonce,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct" },
    }),
    "sig",
  ].join(".");
}

function credential(expiresAt: number): OpenAISubscriptionCredential {
  return {
    accessToken: jwt(expiresAt, "initial"),
    refreshToken: "rt-0",
    expiresAt,
    accountId: "acct",
  };
}

/** Rotating refresh tokens, like auth.openai.com: each works once. */
function oauthServer(options: { failWith?: unknown } = {}) {
  const valid = new Set(["rt-0"]);
  const calls: string[] = [];
  let counter = 0;
  const fetchFn: typeof fetch = async (_input, init) => {
    const token = new URLSearchParams(String(init?.body)).get("refresh_token")!;
    calls.push(token);
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (options.failWith || !valid.delete(token)) {
      return Response.json(
        options.failWith ?? { error: "refresh_token_reused" },
        {
          status: 400,
        },
      );
    }
    counter += 1;
    valid.add(`rt-${counter}`);
    return Response.json({
      access_token: jwt(Date.now() + 60 * MINUTE, `at-${counter}`),
      refresh_token: `rt-${counter}`,
      expires_in: 3600,
    });
  };
  return { fetchFn, calls };
}

describe("PostgresCredentialStore", () => {
  it("stores the credential sealed, never in plain text", async () => {
    const saved = credential(Date.now() + 60 * MINUTE);
    await new PostgresCredentialStore(db, box).replace(saved);

    const [row] = await db.select().from(openaiCredentials);
    expect(row?.credential).toMatch(/^v1\./);
    expect(row?.credential).not.toContain(saved.refreshToken);
    expect(
      unwrap(await new PostgresCredentialStore(db, box).load()).credential,
    ).toEqual(saved);
  });

  it("treats tokens sealed with a lost key as logged out, so a new login works", async () => {
    await new PostgresCredentialStore(db, box).replace(
      credential(Date.now() + 60 * MINUTE),
    );
    const newKey = unwrap(
      SecretBox.fromKeys([randomBytes(32).toString("base64")]),
    );
    const store = new PostgresCredentialStore(db, newKey);

    expect(await store.load()).toMatchObject({
      credential: null,
      reauth: { code: "undecryptable" },
    });

    const fresh = credential(Date.now() + 60 * MINUTE);
    await store.replace(fresh);
    expect(unwrap(await store.load()).credential).toEqual(fresh);
  });

  it("lets only one of several instances spend the refresh token", async () => {
    await new PostgresCredentialStore(db, box).replace(
      credential(Date.now() + MINUTE),
    );
    const oauth = oauthServer();
    const instances = Array.from(
      { length: 4 },
      () =>
        new OpenAISubscriptionAuth({
          store: new PostgresCredentialStore(db, box),
          fetchFn: oauth.fetchFn,
          leasePollIntervalMs: 10,
        }),
    );

    const results = await Promise.all(
      instances.map((auth) => auth.getCredential()),
    );

    expect(oauth.calls).toEqual(["rt-0"]);
    expect(
      new Set(results.map((result) => unwrap(result).refreshToken)),
    ).toEqual(new Set(["rt-1"]));
  });

  it("remembers a dead session for every instance", async () => {
    await new PostgresCredentialStore(db, box).replace(
      credential(Date.now() + MINUTE),
    );
    const oauth = oauthServer({ failWith: { error: "invalid_grant" } });
    const first = new OpenAISubscriptionAuth({
      store: new PostgresCredentialStore(db, box),
      fetchFn: oauth.fetchFn,
    });
    const second = new OpenAISubscriptionAuth({
      store: new PostgresCredentialStore(db, box),
      fetchFn: oauth.fetchFn,
    });

    expect(await first.getCredential()).toBeInstanceOf(ReauthRequiredError);
    expect(await second.getCredential()).toBeInstanceOf(ReauthRequiredError);
    expect(oauth.calls).toHaveLength(1);
    expect(await second.status()).toMatchObject({ state: "reauth_required" });
  });
});

describe("PostgresDeviceLoginStore", () => {
  it("keeps one pending login until it expires", async () => {
    const store = new PostgresDeviceLoginStore(db, box);
    const pending = {
      deviceAuthId: "dev_secret",
      userCode: "ABCD-1234",
      verificationUrl: "https://auth.openai.com/codex/device",
      expiresAt: Date.now() + 15 * MINUTE,
      pollIntervalMs: 5000,
    };

    await store.save(pending);
    expect(await store.get()).toEqual(pending);
    expect(await store.get(pending.expiresAt)).toBeNull();

    await store.clear();
    expect(await store.get()).toBeNull();
  });
});

describe("SecretBox", () => {
  it("decrypts with a rotated-out key and binds the ciphertext to its place", () => {
    const oldKey = randomBytes(32).toString("base64");
    const sealed = unwrap(SecretBox.fromKeys([oldKey])).seal("secret", "row:1");
    const rotated = unwrap(
      SecretBox.fromKeys([randomBytes(32).toString("base64"), oldKey]),
    );

    expect(rotated.open(sealed, "row:1")).toBe("secret");
    expect(rotated.open(sealed, "row:2")).toBeInstanceOf(Error);
  });
});
