import {
  OpenAISubscriptionAuth,
  createOpenAISubscriptionProvider,
  defaultAttribution,
} from "@repo/openai-subscription";
import { PostgresCredentialStore } from "./openai-store";

/**
 * ChatGPT session backed by Postgres. Cheap to create: all state is in the
 * database. A session that needs a new login is only logged for now; the
 * owner is not notified yet.
 */
export function createOpenAIAuth(): OpenAISubscriptionAuth {
  return new OpenAISubscriptionAuth({
    store: new PostgresCredentialStore(),
    attribution: defaultAttribution(),
    onReauthRequired: (info) => {
      console.warn(`ChatGPT session needs a new login: ${info.reason}`);
    },
    onError: (error) => console.warn("ChatGPT token refresh failed", error),
  });
}

/**
 * AI SDK model `modelId` on the owner's ChatGPT subscription, with the
 * session from Postgres. Callers pass only the model: the session check
 * happens inside each model call, and a missing or dead session arrives as
 * a stream `error` part that `isLoginRequired` recognizes. It hides the
 * session wiring from the agent turn, its caller.
 */
export function createOpenAISubscription(modelId: string) {
  return createOpenAISubscriptionProvider({ auth: createOpenAIAuth() })(
    modelId,
  );
}
