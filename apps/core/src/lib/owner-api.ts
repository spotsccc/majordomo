import { z } from "zod";

/** Browser-side calls to the owner API (`Authorization: Bearer $MAJORDOMO_API_TOKEN`). */

const LoginPromptSchema = z.object({
  verificationUrl: z.string(),
  userCode: z.string(),
  expiresAt: z.string(),
  pollIntervalMs: z.number(),
});
export type LoginPrompt = z.infer<typeof LoginPromptSchema>;

const AuthStatusSchema = z.object({
  state: z.enum(["logged_out", "active", "reauth_required"]),
  email: z.string().nullish(),
  planType: z.string().nullish(),
});
export type AuthStatus = z.infer<typeof AuthStatusSchema>;

const LoginProgressSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending") }),
  z.object({ state: z.literal("complete") }),
  z.object({ state: z.literal("none") }),
  z.object({ state: z.literal("failed"), message: z.string() }),
]);
export type LoginProgress = z.infer<typeof LoginProgressSchema>;

const LoginUnavailableSchema = z.object({
  error: z.literal("device_login_unavailable"),
  message: z.string(),
});

/** `fetch` for the AI SDK chat transport: adds the owner token. */
export function agentFetch(token: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
}

export function getAuthStatus(token: string): Promise<Error | AuthStatus> {
  return call(token, "GET", "/api/openai/status", AuthStatusSchema);
}

export type LoginStart =
  | { state: "code"; prompt: LoginPrompt }
  | { state: "unavailable"; message: string };

/** Starts a device login or returns the one in progress. */
export async function startLogin(token: string): Promise<Error | LoginStart> {
  const response = await send(token, "POST", "/api/openai/login");
  if (response instanceof Error) return response;

  if (response.status === 409) {
    const unavailable = LoginUnavailableSchema.safeParse(response.body);
    if (unavailable.success) {
      return { state: "unavailable", message: unavailable.data.message };
    }
  }
  const prompt = parse(response, LoginPromptSchema);
  if (prompt instanceof Error) return prompt;

  return { state: "code", prompt };
}

export function checkLogin(token: string): Promise<Error | LoginProgress> {
  return call(token, "GET", "/api/openai/login", LoginProgressSchema);
}

export async function logout(token: string): Promise<Error | undefined> {
  const response = await call(
    token,
    "POST",
    "/api/openai/logout",
    z.object({ state: z.literal("logged_out") }),
  );
  if (response instanceof Error) return response;
}

interface ApiResponse {
  status: number;
  ok: boolean;
  body: unknown;
}

async function call<T>(
  token: string,
  method: string,
  path: string,
  schema: z.ZodType<T>,
): Promise<Error | T> {
  const response = await send(token, method, path);
  if (response instanceof Error) return response;

  return parse(response, schema);
}

async function send(
  token: string,
  method: string,
  path: string,
): Promise<Error | ApiResponse> {
  const response = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${token}` },
  }).catch((cause) => new Error("Сервер недоступен", { cause }));
  if (response instanceof Error) return response;

  const body: unknown = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, body };
}

function parse<T>(response: ApiResponse, schema: z.ZodType<T>): Error | T {
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(response.body);
    if (response.status === 401) return new Error("Неверный токен владельца");
    return new Error(
      error.success ? error.data.error : `Сервер ответил ${response.status}`,
    );
  }
  const parsed = schema.safeParse(response.body);
  if (!parsed.success) {
    return new Error("Неожиданный ответ сервера", { cause: parsed.error });
  }
  return parsed.data;
}
