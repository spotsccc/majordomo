import type { OpenAISubscriptionCredential } from "@fieldwork-ai/codex-transport";

export const ACCOUNT_ID = "acct_test";

/** Unsigned JWT with the claims the transport reads. */
export function accessToken(options: {
  expiresAt: number;
  nonce?: string;
}): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    encode({ alg: "none" }),
    encode({
      exp: Math.floor(options.expiresAt / 1000),
      nonce: options.nonce ?? Math.random().toString(36),
      "https://api.openai.com/auth": {
        chatgpt_account_id: ACCOUNT_ID,
        chatgpt_plan_type: "pro",
      },
      "https://api.openai.com/profile": { email: "owner@example.com" },
    }),
    "signature",
  ].join(".");
}

export function credential(
  expiresAt: number,
  refreshToken = "rt-0",
): OpenAISubscriptionCredential {
  return {
    accessToken: accessToken({ expiresAt }),
    refreshToken,
    expiresAt,
    accountId: ACCOUNT_ID,
  };
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export interface FakeOAuthServer {
  fetch: typeof fetch;
  refreshCalls: string[];
  /** Makes the next refresh fail with this response. */
  failNextRefresh(status: number, body: unknown): void;
}

/** Imitates auth.openai.com token rotation: every refresh token works exactly once. */
export function fakeOAuthServer(
  options: { lifetimeMs?: number; delayMs?: number } = {},
): FakeOAuthServer {
  const lifetimeMs = options.lifetimeMs ?? 60 * 60_000;
  const valid = new Set(["rt-0"]);
  const refreshCalls: string[] = [];
  let failure: Response | undefined;
  let counter = 0;

  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.endsWith("/oauth/token"))
      throw new Error(`unexpected request to ${url}`);
    const form = new URLSearchParams(String(init?.body));
    const refreshToken = form.get("refresh_token") ?? "";
    refreshCalls.push(refreshToken);
    if (options.delayMs)
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    if (failure) {
      const response = failure;
      failure = undefined;
      return response;
    }
    if (!valid.delete(refreshToken))
      return json(400, { error: "refresh_token_reused" });
    counter += 1;
    const next = `rt-${counter}`;
    valid.add(next);
    return json(200, {
      access_token: accessToken({
        expiresAt: Date.now() + lifetimeMs,
        nonce: `at-${counter}`,
      }),
      refresh_token: next,
      expires_in: lifetimeMs / 1000,
    });
  };

  return {
    fetch: fetchFn,
    refreshCalls,
    failNextRefresh(status, body) {
      failure = json(status, body);
    },
  };
}
