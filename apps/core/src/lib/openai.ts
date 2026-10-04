import {
  PostgresCredentialStore,
  PostgresDeviceLoginStore,
  SecretBox,
} from "@repo/db";
import {
  OpenAISubscriptionAuth,
  defaultAttribution,
} from "@repo/openai-subscription";
import { getDb } from "./db";
import { ConfigurationError, requiredEnv } from "./env";

/** ChatGPT session backed by Postgres. Cheap to create: all state is in the database. */
export function createOpenAIAuth():
  | ConfigurationError
  | OpenAISubscriptionAuth {
  const db = getDb();
  if (db instanceof Error) return db;

  const box = createSecretBox();
  if (box instanceof Error) return box;

  return new OpenAISubscriptionAuth({
    store: new PostgresCredentialStore(db, box),
    attribution: defaultAttribution(),
    onReauthRequired: (info) => {
      // TODO: notify the owner (push) with a fresh login code.
      console.warn(`ChatGPT session needs a new login: ${info.reason}`);
    },
    onError: (error) => console.warn("ChatGPT token refresh failed", error),
  });
}

export function createDeviceLoginStore():
  | ConfigurationError
  | PostgresDeviceLoginStore {
  const db = getDb();
  if (db instanceof Error) return db;

  const box = createSecretBox();
  if (box instanceof Error) return box;

  return new PostgresDeviceLoginStore(db, box);
}

// Without the key (e.g. on a preview deployment) nothing touches the tokens.
function createSecretBox(): ConfigurationError | SecretBox {
  const keys = requiredEnv("SECRETS_ENCRYPTION_KEYS");
  if (keys instanceof Error) return keys;

  const box = SecretBox.fromKeys(keys.split(",").map((key) => key.trim()));
  if (box instanceof Error) {
    return new ConfigurationError({
      message: `SECRETS_ENCRYPTION_KEYS задан неверно: ${box.message}`,
      cause: box,
    });
  }
  return box;
}
