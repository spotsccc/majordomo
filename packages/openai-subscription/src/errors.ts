import type { ReauthInfo } from "./store.js";

export class NotLoggedInError extends Error {
  override readonly name = "NotLoggedInError";

  constructor() {
    super("Вход в ChatGPT не выполнен.");
  }
}

/** The saved session is dead (revoked, expired or rotated elsewhere); only a new login helps. */
export class ReauthRequiredError extends Error {
  override readonly name = "ReauthRequiredError";
  readonly info: ReauthInfo;

  constructor(info: ReauthInfo) {
    super(`Нужно заново войти в ChatGPT: ${info.reason}`);
    this.info = info;
  }
}

/** Device login is disabled for the account; the browser flow still works. */
export class DeviceLoginUnavailableError extends Error {
  override readonly name = "DeviceLoginUnavailableError";

  constructor(options?: ErrorOptions) {
    super(
      "Вход по коду устройства недоступен для этого аккаунта. Включите его в настройках безопасности ChatGPT или используйте вход через браузер (`login --browser`).",
      options,
    );
  }
}

/** Codes after which the refresh token is known to be unusable (see codex-rs/login auth/manager.rs). */
const PERMANENT_CODES = new Set([
  "invalid_grant",
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated",
]);

const REASONS: Record<string, string> = {
  refresh_token_expired: "срок действия refresh-токена истёк",
  refresh_token_reused:
    "refresh-токен уже был использован (сессию обновил другой клиент)",
  refresh_token_invalidated: "refresh-токен отозван",
  invalid_grant: "OpenAI отклонил refresh-токен",
};

export class RefreshError extends Error {
  override readonly name = "RefreshError";
  readonly permanent: boolean;
  readonly status?: number;
  readonly code?: string;

  constructor(
    message: string,
    permanent: boolean,
    status?: number,
    code?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.permanent = permanent;
    this.status = status;
    this.code = code;
  }

  /** Classifies a failed refresh from the HTTP status and OAuth error code of the token response. */
  static from(error: unknown, response?: OAuthErrorResponse): RefreshError {
    const message = error instanceof Error ? error.message : String(error);
    if (response) {
      const permanent =
        response.status === 401 ||
        (response.code !== undefined && PERMANENT_CODES.has(response.code));
      const reason = (response.code && REASONS[response.code]) ?? message;
      return new RefreshError(
        reason,
        permanent,
        response.status,
        response.code,
        { cause: error },
      );
    }
    // Thrown after a successful HTTP exchange when the token belongs to another account.
    const permanent = /different ChatGPT account/i.test(message);
    return new RefreshError(message, permanent, undefined, undefined, {
      cause: error,
    });
  }
}

export interface OAuthErrorResponse {
  status: number;
  code?: string;
}

/**
 * `@fieldwork-ai/codex-transport` reports only "HTTP 400" for a failed refresh.
 * This fetch wrapper keeps the status and OAuth error code of the last failed
 * response, which is what separates a dead session from a temporary failure.
 */
export function captureOAuthErrors(base: typeof fetch): {
  fetchFn: typeof fetch;
  last(): OAuthErrorResponse | undefined;
} {
  let last: OAuthErrorResponse | undefined;
  const fetchFn: typeof fetch = async (input, init) => {
    const response = await base(input, init);
    if (!response.ok)
      last = {
        status: response.status,
        code: await errorCodeOf(response.clone()),
      };
    return response;
  };
  return { fetchFn, last: () => last };
}

async function errorCodeOf(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = JSON.parse(await response.text());
    if (!body || typeof body !== "object") return undefined;
    const { error, code } = body as { error?: unknown; code?: unknown };
    const value =
      typeof error === "string"
        ? error
        : error &&
            typeof error === "object" &&
            typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : typeof code === "string"
            ? code
            : undefined;
    return value?.toLowerCase();
  } catch {
    return undefined;
  }
}
