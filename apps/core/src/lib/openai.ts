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
import { requiredEnv } from "./env";

/** ChatGPT session backed by Postgres. Cheap to create: all state is in the database. */
export function createOpenAIAuth(): OpenAISubscriptionAuth {
  return new OpenAISubscriptionAuth({
    store: new PostgresCredentialStore(getDb(), createSecretBox()),
    attribution: defaultAttribution(),
    onReauthRequired: (info) => {
      // TODO: notify the owner (push) with a fresh login code.
      console.warn(`ChatGPT session needs a new login: ${info.reason}`);
    },
    onError: (error) => console.warn("ChatGPT token refresh failed", error),
  });
}

export function createDeviceLoginStore(): PostgresDeviceLoginStore {
  return new PostgresDeviceLoginStore(getDb(), createSecretBox());
}

// Without the key (e.g. on a preview deployment) nothing touches the tokens.
function createSecretBox(): SecretBox {
  return new SecretBox(
    requiredEnv("SECRETS_ENCRYPTION_KEYS")
      .split(",")
      .map((key) => key.trim()),
  );
}
