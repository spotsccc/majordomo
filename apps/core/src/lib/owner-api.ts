import { z } from "zod";

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

export function getAuthStatus(): Promise<Error | AuthStatus> {
  return call("GET", "/api/openai/status", AuthStatusSchema);
}

export type LoginStart =
  | { state: "code"; prompt: LoginPrompt }
  | { state: "unavailable"; message: string };

export async function startLogin(): Promise<Error | LoginStart> {
  const response = await send("POST", "/api/openai/login");
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

export function checkLogin(): Promise<Error | LoginProgress> {
  return call("GET", "/api/openai/login", LoginProgressSchema);
}

export async function logout(): Promise<Error | undefined> {
  const response = await call(
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
  method: string,
  path: string,
  schema: z.ZodType<T>,
): Promise<Error | T> {
  const response = await send(method, path);
  if (response instanceof Error) return response;

  return parse(response, schema);
}

async function send(
  method: string,
  path: string,
): Promise<Error | ApiResponse> {
  const response = await fetch(path, { method }).catch(
    (cause) => new Error("Сервер недоступен", { cause }),
  );
  if (response instanceof Error) return response;

  const body: unknown = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, body };
}

function parse<T>(response: ApiResponse, schema: z.ZodType<T>): Error | T {
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(response.body);
    if (response.status === 401)
      return new Error("Вход устарел: войдите заново");
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
