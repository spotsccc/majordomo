import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

async function loadConfig() {
  const { config } = await import("./config");
  return config;
}

describe("config", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("parses the environment and builds the secret box", async () => {
    const config = await loadConfig();
    expect(config.MAJORDOMO_API_TOKEN).toBe(process.env.MAJORDOMO_API_TOKEN);
    const sealed = config.SECRETS_ENCRYPTION_KEYS.seal("secret", "row:1");
    expect(config.SECRETS_ENCRYPTION_KEYS.open(sealed, "row:1")).toBe("secret");
  });

  it("falls back to the default model when OPENAI_MODEL is unset or empty", async () => {
    vi.stubEnv("OPENAI_MODEL", "");
    expect((await loadConfig()).OPENAI_MODEL).toBe("gpt-5.6-luna");

    vi.resetModules();
    vi.stubEnv("OPENAI_MODEL", "gpt-other");
    expect((await loadConfig()).OPENAI_MODEL).toBe("gpt-other");
  });

  it("decrypts with every key and encrypts with the first one", async () => {
    const oldKey = randomBytes(32).toString("base64");
    vi.stubEnv("SECRETS_ENCRYPTION_KEYS", oldKey);
    const sealed = (await loadConfig()).SECRETS_ENCRYPTION_KEYS.seal("secret");

    vi.resetModules();
    vi.stubEnv(
      "SECRETS_ENCRYPTION_KEYS",
      `${randomBytes(32).toString("base64")}, ${oldKey}`,
    );
    expect((await loadConfig()).SECRETS_ENCRYPTION_KEYS.open(sealed)).toBe(
      "secret",
    );
  });

  it("fails to load when a variable is missing or empty", async () => {
    vi.stubEnv("CRON_SECRET", undefined);
    vi.stubEnv("DATABASE_URL", "");
    const load = loadConfig();
    await expect(load).rejects.toThrow("CRON_SECRET");
    await expect(load).rejects.toThrow("DATABASE_URL");
  });

  it("fails to load with a short owner token or a malformed key", async () => {
    vi.stubEnv("MAJORDOMO_API_TOKEN", "short");
    vi.stubEnv("SECRETS_ENCRYPTION_KEYS", "not-a-32-byte-key");
    const load = loadConfig();
    await expect(load).rejects.toThrow("MAJORDOMO_API_TOKEN");
    await expect(load).rejects.toThrow(
      "Encryption key must be 32 bytes, base64-encoded",
    );
  });
});
