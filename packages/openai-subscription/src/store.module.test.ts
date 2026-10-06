import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unwrap } from "@spotsccc/error-as-value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAISubscriptionAuth } from "./auth.js";
import { ReauthRequiredError } from "./errors.js";
import { credential, fakeOAuthServer } from "./oauth.test-utils.js";
import { FileCredentialStore } from "./store.js";

const MINUTE = 60_000;

describe("FileCredentialStore", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "openai-subscription-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("persists the credential with owner-only permissions", async () => {
    const path = join(directory, "nested", "auth.json");
    const saved = credential(Date.now() + 60 * MINUTE);
    await new FileCredentialStore(path).replace(saved);

    const state = await new FileCredentialStore(path).load();
    expect(state).toMatchObject({
      generation: 1,
      credential: saved,
      reauth: null,
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("tells a long-running process about a session that died elsewhere", async () => {
    const path = join(directory, "auth.json");
    await new FileCredentialStore(path).replace(
      credential(Date.now() + MINUTE),
    );
    const oauth = fakeOAuthServer();
    oauth.failNextRefresh(400, { error: "invalid_grant" });
    const cli = new OpenAISubscriptionAuth({
      store: new FileCredentialStore(path),
      fetchFn: oauth.fetch,
    });
    const onReauthRequired = vi.fn();
    const server = new OpenAISubscriptionAuth({
      store: new FileCredentialStore(path),
      fetchFn: oauth.fetch,
      onReauthRequired,
    });

    expect(await cli.getCredential()).toBeInstanceOf(ReauthRequiredError);
    server.start();
    await vi.waitFor(() => expect(onReauthRequired).toHaveBeenCalledOnce());
    server.stop();
    expect(onReauthRequired.mock.calls[0]?.[0]).toMatchObject({
      code: "invalid_grant",
    });
  });

  it("lets only one of several processes spend the refresh token", async () => {
    const path = join(directory, "auth.json");
    await new FileCredentialStore(path).replace(
      credential(Date.now() + MINUTE),
    );
    const oauth = fakeOAuthServer({ delayMs: 50 });
    // Separate store and auth instances stand in for separate processes.
    const processes = Array.from(
      { length: 4 },
      () =>
        new OpenAISubscriptionAuth({
          store: new FileCredentialStore(path),
          fetchFn: oauth.fetch,
        }),
    );

    const results = await Promise.all(
      processes.map((auth) => auth.getCredential()),
    );

    expect(oauth.refreshCalls).toEqual(["rt-0"]);
    expect(
      new Set(results.map((result) => unwrap(result).refreshToken)),
    ).toEqual(new Set(["rt-1"]));
    expect(await processes[0]!.status()).toMatchObject({ state: "active" });
  });
});
