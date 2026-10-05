import { PostgresCredentialStore, PostgresDeviceLoginStore } from "@repo/db";
import {
  OpenAISubscriptionAuth,
  defaultAttribution,
} from "@repo/openai-subscription";
import { config } from "./config";
import { db } from "./db";

/**
 * ChatGPT session backed by Postgres. Cheap to create: all state is in the
 * database. A session that needs a new login is only logged for now; the
 * owner is not notified yet.
 */
export function createOpenAIAuth(): OpenAISubscriptionAuth {
  return new OpenAISubscriptionAuth({
    store: new PostgresCredentialStore(db, config.SECRETS_ENCRYPTION_KEYS),
    attribution: defaultAttribution(),
    onReauthRequired: (info) => {
      console.warn(`ChatGPT session needs a new login: ${info.reason}`);
    },
    onError: (error) => console.warn("ChatGPT token refresh failed", error),
  });
}

export function createDeviceLoginStore(): PostgresDeviceLoginStore {
  return new PostgresDeviceLoginStore(db, config.SECRETS_ENCRYPTION_KEYS);
}
