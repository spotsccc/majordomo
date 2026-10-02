import {
  PostgresCredentialStore,
  PostgresDeviceLoginStore,
  SecretBox,
  createDatabase,
} from "@repo/db";
import {
  OpenAISubscriptionAuth,
  createOpenAISubscription,
  defaultAttribution,
} from "@repo/openai-subscription";
import { attachDatabasePool } from "@vercel/functions";
import { DEFAULT_MODEL, requiredEnv } from "./env";

function createServices() {
  const { db, pool } = createDatabase(requiredEnv("DATABASE_URL"));
  // Lets Vercel close idle connections before a function instance is frozen.
  attachDatabasePool(pool);
  // Without the key (e.g. on a preview deployment) nothing touches the tokens.
  const box = new SecretBox(
    requiredEnv("SECRETS_ENCRYPTION_KEYS")
      .split(",")
      .map((key) => key.trim()),
  );
  const auth = new OpenAISubscriptionAuth({
    store: new PostgresCredentialStore(db, box),
    attribution: defaultAttribution(),
    onReauthRequired: (info) => {
      // TODO: notify the owner (push) with a fresh login code.
      console.warn(`ChatGPT session needs a new login: ${info.reason}`);
    },
    onError: (error) => console.warn("ChatGPT token refresh failed", error),
  });
  return {
    db,
    auth,
    deviceLogins: new PostgresDeviceLoginStore(db, box),
    openai: createOpenAISubscription({ auth }),
    model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
  };
}

export type Services = ReturnType<typeof createServices>;

// One set per function instance, reused across requests (and across hot reloads in dev).
const cache = globalThis as { majordomoServices?: Services };

export function services(): Services {
  cache.majordomoServices ??= createServices();
  return cache.majordomoServices;
}
