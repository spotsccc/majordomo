import {
  OpenAISubscriptionAuth,
  createOpenAISubscriptionProvider,
  defaultAttribution,
} from "@repo/openai-subscription";
import { PostgresCredentialStore } from "./openai-store";

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

export function createOpenAISubscription(modelId: string) {
  return createOpenAISubscriptionProvider({ auth: createOpenAIAuth() })(
    modelId,
  );
}
