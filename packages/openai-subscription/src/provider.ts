import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import {
  OPENAI_SUBSCRIPTION_PROVIDER,
  createOpenAISubscriptionModel,
  type OpenAISubscriptionModelOptions,
} from "@fieldwork-ai/codex-transport";
import type { OpenAISubscriptionAuth } from "./auth.js";
import { isLoginRequired, RefreshError } from "./errors.js";

export interface OpenAISubscriptionProviderOptions {
  auth: OpenAISubscriptionAuth;
  baseUrl?: string;
  /** The 401 retry only covers HTTP; WebSocket requests still get a fresh token. */
  transport?: "sse" | "websocket" | "auto";
  compression?: boolean;
}

export type OpenAISubscriptionModelSettings = Pick<
  OpenAISubscriptionModelOptions,
  "isModelImageMime" | "fedramp"
>;

/**
 * The transport turns fetch failures into plain messages, so the typed auth error caught in its
 * fetch replaces them.
 */
export function createOpenAISubscriptionProvider(
  options: OpenAISubscriptionProviderOptions,
) {
  const authenticatedFetch = createAuthenticatedFetch(
    options.auth,
    options.auth.fetchFn,
  );
  return (
    modelId: string,
    settings: OpenAISubscriptionModelSettings = {},
  ): LanguageModelV4 => {
    const resolve = async () => {
      const credential = await options.auth.getCredential();
      if (credential instanceof Error) throw credential;
      let authError: Error | undefined;
      const fetchFn: typeof fetch = async (input, init) => {
        try {
          return await authenticatedFetch(input, init);
        } catch (error) {
          if (isAuthError(error)) authError = error;
          throw error;
        }
      };
      const model = createOpenAISubscriptionModel({
        ...settings,
        modelId,
        accessToken: credential.accessToken,
        accountId: credential.accountId,
        attribution: options.auth.attribution,
        baseUrl: options.baseUrl,
        transport: options.transport,
        compression: options.compression,
        fetchFn,
      });
      return { model, authError: () => authError };
    };
    return {
      specificationVersion: "v4",
      provider: OPENAI_SUBSCRIPTION_PROVIDER,
      modelId,
      supportedUrls: {},
      async doGenerate(call: LanguageModelV4CallOptions) {
        const { model, authError } = await resolve();
        try {
          return await model.doGenerate(call);
        } catch (error) {
          throw authError() ?? error;
        }
      },
      async doStream(call: LanguageModelV4CallOptions) {
        const { model, authError } = await resolve();
        const result = await model.doStream(call);
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream<
              LanguageModelV4StreamPart,
              LanguageModelV4StreamPart
            >({
              transform(part, controller) {
                const error = part.type === "error" ? authError() : undefined;
                controller.enqueue(error ? { type: "error", error } : part);
              },
            }),
          ),
        };
      },
    };
  };
}

function isAuthError(error: unknown): error is Error {
  return isLoginRequired(error) || error instanceof RefreshError;
}

/** Request bodies are strings or byte arrays here, so resending after a 401 is safe. */
export function createAuthenticatedFetch(
  auth: OpenAISubscriptionAuth,
  base: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    const response = await base(input, init);
    if (response.status !== 401) return response;
    const stale = bearerToken(init?.headers);
    if (!stale || init?.signal?.aborted) return response;
    await response.body?.cancel().catch(() => {});
    const credential = await auth.refreshAfterUnauthorized(stale);
    if (credential instanceof Error) throw credential;
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${credential.accessToken}`);
    headers.set("ChatGPT-Account-Id", credential.accountId);
    return base(input, { ...init, headers });
  };
}

function bearerToken(headers: HeadersInit | undefined): string | undefined {
  const value = new Headers(headers).get("Authorization");
  return value?.match(/^Bearer (.+)$/)?.[1];
}
