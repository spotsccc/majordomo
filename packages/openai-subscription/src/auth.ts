import { arch, platform } from "node:os";
import {
  fetchCodexUsage,
  planTypeFromAccessToken,
  refreshOpenAISubscriptionCredential,
  refreshWithCredentialLease,
  type CodexUsageSnapshot,
  type OpenAISubscriptionAttribution,
  type OpenAISubscriptionCredential,
  type OpenAISubscriptionRefreshStore,
} from "@fieldwork-ai/codex-transport";
import { tryAsync } from "@spotsccc/error-as-value";
import {
  captureOAuthErrors,
  isLoginRequired,
  NotLoggedInError,
  ReauthRequiredError,
  RefreshError,
} from "./errors.js";
import type { CredentialStore, ReauthInfo, StoredAuthState } from "./store.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** setTimeout overflows above 2^31-1 ms; wake up at least this often and re-read the store. */
const MAX_SLEEP_MS = 6 * 60 * MINUTE;
const LOGGED_OUT_RECHECK_MS = 5 * MINUTE;
const MIN_RETRY_MS = 30_000;
const MAX_RETRY_MS = 15 * MINUTE;
/** Pause after a successful refresh, so a token that looks due right away cannot cause a refresh loop. */
const AFTER_REFRESH_MS = MINUTE;
const REVOKE_URL = "https://auth.openai.com/oauth/revoke";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export function defaultAttribution(
  version = "0.0.0",
): OpenAISubscriptionAttribution {
  return {
    originator: "majordomo",
    userAgent: `majordomo/${version} (${platform()}; ${arch()}) node/${process.versions.node}`,
    version,
  };
}

export interface OpenAISubscriptionAuthOptions {
  store: CredentialStore;
  attribution?: OpenAISubscriptionAttribution;
  fetchFn?: typeof fetch;
  /** A request refreshes first if the access token expires sooner than this. Default 5 minutes. */
  minValidityMs?: number;
  /** The background keeper refreshes this long before expiry. Default 30 minutes. */
  refreshAheadMs?: number;
  /** Refresh at least this often even if the access token lives longer. Default 8 days, like Codex. */
  maxTokenAgeMs?: number;
  /**
   * How long one process may hold the refresh lease. It must outlast the token
   * request (30 s timeout): a spent refresh token cannot be used again. Default 2 minutes.
   */
  refreshLeaseMs?: number;
  /** How often a process waiting for another one's refresh re-reads the store. Default 250 ms. */
  leasePollIntervalMs?: number;
  /**
   * Called once per dead session when the user has to log in again, including in
   * a long-running process when another process (e.g. the CLI) discovered it.
   */
  onReauthRequired?: (info: ReauthInfo) => void;
  /** Called after this process refreshed or saved a new credential. */
  onCredentialChanged?: (status: AuthStatus) => void;
  /** Temporary failures that were handled by retrying later. */
  onError?: (error: unknown) => void;
  now?: () => number;
}

export type AuthStatus =
  | { state: "logged_out" }
  | ({
      state: "active" | "reauth_required";
      reauth: ReauthInfo | null;
    } & AccountInfo);

export type RefreshCheck =
  | { state: "logged_out" }
  | { state: "reauth_required"; reauth: ReauthInfo }
  | { state: "fresh"; dueAt: number }
  | { state: "refreshed" };

export interface AccountInfo {
  accountId: string;
  email: string | null;
  planType: string | null;
  expiresAt: number;
  refreshedAt: number | null;
}

/**
 * Keeps a ChatGPT subscription session alive.
 *
 * - `getCredential()` returns a valid access token and refreshes it on demand.
 * - `start()` runs a background keeper that refreshes before expiry, so requests
 *   rarely wait and the refresh token does not age out while the assistant is idle.
 * - Refreshes are coordinated through the store's lease, so several processes
 *   sharing one store never spend the same rotating refresh token twice.
 * - A permanent failure is saved in the store and reported via `onReauthRequired`.
 *
 * Failures are returned as values. `NotLoggedInError` and `ReauthRequiredError`
 * (see `isLoginRequired`) mean that only a new login helps.
 */
export class OpenAISubscriptionAuth {
  readonly store: CredentialStore;
  readonly attribution: OpenAISubscriptionAttribution;
  readonly fetchFn: typeof fetch;
  private readonly minValidityMs: number;
  private readonly refreshAheadMs: number;
  private readonly maxTokenAgeMs: number;
  private readonly refreshLeaseMs: number;
  private readonly leasePollIntervalMs: number;
  private readonly now: () => number;
  private readonly inflight = new Map<
    string,
    Promise<Error | OpenAISubscriptionCredential>
  >();
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private failures = 0;
  private reportedReauthAt: number | undefined;
  private readonly options: OpenAISubscriptionAuthOptions;

  constructor(options: OpenAISubscriptionAuthOptions) {
    this.options = options;
    this.store = options.store;
    this.attribution = options.attribution ?? defaultAttribution();
    this.fetchFn = options.fetchFn ?? fetch;
    this.minValidityMs = options.minValidityMs ?? 5 * MINUTE;
    this.refreshAheadMs = options.refreshAheadMs ?? 30 * MINUTE;
    this.maxTokenAgeMs = options.maxTokenAgeMs ?? 8 * DAY;
    this.refreshLeaseMs = options.refreshLeaseMs ?? 2 * MINUTE;
    this.leasePollIntervalMs = options.leasePollIntervalMs ?? 250;
    this.now = options.now ?? Date.now;
  }

  /** Returns a credential that stays valid for at least `minValidityMs`, refreshing if needed. */
  async getCredential(): Promise<
    | NotLoggedInError
    | ReauthRequiredError
    | Error
    | OpenAISubscriptionCredential
  > {
    const state = await this.store.load();
    if (state instanceof Error) return state;

    const credential = usableCredential(state);
    if (credential instanceof Error) return credential;
    if (this.now() < this.requestDueAt(state, credential)) return credential;

    const refreshed = await this.refreshIfCurrent(credential.accessToken);
    // Any temporary trouble (network, a stuck lease holder in another
    // function instance) must not fail a request while the token still works.
    if (
      refreshed instanceof Error &&
      !isLoginRequired(refreshed) &&
      credential.expiresAt > this.now()
    ) {
      this.options.onError?.(refreshed);
      return credential;
    }
    return refreshed;
  }

  /** Called after the API answered 401 to `staleAccessToken`: refresh unless someone already did. */
  refreshAfterUnauthorized(
    staleAccessToken: string,
  ): Promise<Error | OpenAISubscriptionCredential> {
    return this.refreshIfCurrent(staleAccessToken);
  }

  /** Refreshes right now regardless of expiry. */
  async refreshNow(): Promise<Error | OpenAISubscriptionCredential> {
    const state = await this.store.load();
    if (state instanceof Error) return state;

    const credential = usableCredential(state);
    if (credential instanceof Error) return credential;

    return this.refreshIfCurrent(credential.accessToken);
  }

  async status(): Promise<Error | AuthStatus> {
    const state = await this.store.load();
    if (state instanceof Error) return state;

    if (!state.credential) return { state: "logged_out" };
    return {
      state: state.reauth ? "reauth_required" : "active",
      reauth: state.reauth,
      ...accountInfo(state.credential, state.refreshedAt),
    };
  }

  /** Current subscription limits as reported by ChatGPT. */
  async usage(): Promise<Error | CodexUsageSnapshot> {
    const credential = await this.getCredential();
    if (credential instanceof Error) return credential;

    return tryAsync(
      () =>
        fetchCodexUsage({
          attribution: this.attribution,
          accessToken: credential.accessToken,
          accountId: credential.accountId,
          fetchFn: this.fetchFn,
        }),
      (error) => error,
    );
  }

  /** Saves the credential from a finished login flow and resumes background refresh. */
  async saveLogin(
    credential: OpenAISubscriptionCredential,
  ): Promise<Error | AuthStatus> {
    const replaced = await this.store.replace(credential);
    if (replaced instanceof Error) return replaced;

    this.failures = 0;
    const status = await this.status();
    if (status instanceof Error) return status;

    this.options.onCredentialChanged?.(status);
    if (this.running) this.schedule(0);
    return status;
  }

  /** Forgets the credential and, by default, revokes its refresh token at OpenAI. */
  async logout(options: { revoke?: boolean } = {}): Promise<Error | undefined> {
    const state = await this.store.load();
    if (state instanceof Error) return state;

    const replaced = await this.store.replace(null);
    if (replaced instanceof Error) return replaced;

    if (state.credential && options.revoke !== false) {
      const revoked = await this.revoke(state.credential.refreshToken);
      if (revoked instanceof Error) this.options.onError?.(revoked);
    }
  }

  /** Starts background refresh. Timers are unref'd and do not keep the process alive. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delayMs: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => void this.tick(),
      Math.max(0, Math.min(delayMs, MAX_SLEEP_MS)),
    );
    this.timer.unref();
  }

  /**
   * One step of background refresh, for environments without long-lived timers
   * (serverless cron). Refreshes if the credential is due within `aheadMs`;
   * pass the cron interval so the next run is not too late.
   */
  async refreshIfDue(
    options: { aheadMs?: number } = {},
  ): Promise<Error | RefreshCheck> {
    const state = await this.store.load();
    if (state instanceof Error) return state;

    if (!state.credential) return { state: "logged_out" };
    if (state.reauth) {
      this.reportReauth(state.reauth);
      return { state: "reauth_required", reauth: state.reauth };
    }
    const dueAt = this.keeperDueAt(state, state.credential);
    if (this.now() < dueAt - (options.aheadMs ?? 0)) {
      return { state: "fresh", dueAt };
    }

    const refreshed = await this.refreshIfCurrent(state.credential.accessToken);
    if (refreshed instanceof ReauthRequiredError) {
      return { state: "reauth_required", reauth: refreshed.info };
    }
    if (refreshed instanceof Error) return refreshed;

    return { state: "refreshed" };
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    // Nothing may escape a timer callback: a throw from a listener would
    // become an unhandled rejection and stop the keeper.
    const check = await tryAsync(
      () => this.refreshIfDue(),
      (error) => error,
    );
    let delay: number;
    if (check instanceof NotLoggedInError) {
      delay = LOGGED_OUT_RECHECK_MS;
    } else if (check instanceof Error) {
      this.failures += 1;
      delay = Math.min(MIN_RETRY_MS * 2 ** (this.failures - 1), MAX_RETRY_MS);
      this.options.onError?.(check);
    } else {
      delay =
        check.state === "fresh"
          ? check.dueAt - this.now()
          : check.state === "refreshed"
            ? AFTER_REFRESH_MS
            : // Wait for a login, possibly made by another process such as the CLI.
              LOGGED_OUT_RECHECK_MS;
      this.failures = 0;
    }
    if (this.running) this.schedule(delay);
  }

  private reportReauth(info: ReauthInfo): void {
    if (this.reportedReauthAt === info.at) return;
    this.reportedReauthAt = info.at;
    this.options.onReauthRequired?.(info);
  }

  /** A request must not start with a token that expires within `minValidityMs`. */
  private requestDueAt(
    state: StoredAuthState,
    credential: OpenAISubscriptionCredential,
  ): number {
    return Math.min(
      credential.expiresAt - this.minValidityMs,
      this.ageLimit(state),
    );
  }

  /**
   * The keeper refreshes `refreshAheadMs` before expiry, but no earlier than half
   * the token's lifetime, so short-lived tokens are not refreshed back to back.
   */
  private keeperDueAt(
    state: StoredAuthState,
    credential: OpenAISubscriptionCredential,
  ): number {
    const issuedAt = state.refreshedAt ?? this.now();
    const lifetime = Math.max(0, credential.expiresAt - issuedAt);
    const ahead = Math.max(
      this.minValidityMs,
      Math.min(this.refreshAheadMs, lifetime / 2),
    );
    return Math.min(credential.expiresAt - ahead, this.ageLimit(state));
  }

  /** Refresh at least every `maxTokenAgeMs`, like Codex, so the refresh token never ages out. */
  private ageLimit(state: StoredAuthState): number {
    return (state.refreshedAt ?? this.now()) + this.maxTokenAgeMs;
  }

  /** Refreshes only if `accessToken` is still the stored one; concurrent callers share one refresh. */
  private refreshIfCurrent(
    accessToken: string,
  ): Promise<Error | OpenAISubscriptionCredential> {
    let pending = this.inflight.get(accessToken);
    if (!pending) {
      pending = this.runRefresh(accessToken).finally(() =>
        this.inflight.delete(accessToken),
      );
      this.inflight.set(accessToken, pending);
    }
    return pending;
  }

  private async runRefresh(
    accessToken: string,
  ): Promise<Error | OpenAISubscriptionCredential> {
    const before = await this.store.load();
    if (before instanceof Error) return before;

    const current = usableCredential(before);
    if (current instanceof Error) return current;
    if (current.accessToken !== accessToken) return current;

    const result = await tryAsync(
      () =>
        refreshWithCredentialLease({
          store: this.leaseStore(),
          shouldRefresh: (credential) => credential.accessToken === accessToken,
          refresh: (credential) => this.exchangeRefreshToken(credential),
          leaseDurationMs: this.refreshLeaseMs,
          waitTimeoutMs: this.refreshLeaseMs + 15_000,
          pollIntervalMs: this.leasePollIntervalMs,
        }),
      (error) => error,
    );
    if (result instanceof RefreshError && result.permanent) {
      return this.requireReauth(before, result);
    }
    if (result instanceof Error) return result;

    if (result.generation !== before.generation) {
      const status = await this.status();
      if (status instanceof Error) return status;
      this.options.onCredentialChanged?.(status);
    }
    return result.credential;
  }

  private async requireReauth(
    before: StoredAuthState,
    error: RefreshError,
  ): Promise<Error | OpenAISubscriptionCredential> {
    // A newer generation means another process refreshed first; the session is fine.
    const after = await this.store.load();
    if (after instanceof Error) return after;
    if (
      after.generation !== before.generation &&
      after.credential &&
      !after.reauth
    )
      return after.credential;

    const info: ReauthInfo = {
      reason: error.message,
      code: error.code,
      at: this.now(),
    };
    const marked = await this.store.markReauthRequired(before.generation, info);
    if (marked instanceof Error) return marked;
    if (marked) this.reportReauth(info);

    return new ReauthRequiredError(info);
  }

  /** The lease protocol of `refreshWithCredentialLease` expects a throw on failure. */
  private exchangeRefreshToken(
    credential: OpenAISubscriptionCredential,
  ): Promise<OpenAISubscriptionCredential> {
    const capture = captureOAuthErrors(this.fetchFn);
    return refreshOpenAISubscriptionCredential(credential, {
      attribution: this.attribution,
      fetchFn: capture.fetchFn,
    }).catch((error: unknown) => {
      throw RefreshError.from(error, capture.last());
    });
  }

  /** Adapts the store to `refreshWithCredentialLease`, which expects throws. */
  private leaseStore(): OpenAISubscriptionRefreshStore {
    const store = this.store;
    return {
      async read() {
        const state = orThrow(await store.load());
        return {
          credential: orThrow(usableCredential(state)),
          generation: state.generation,
        };
      },
      tryAcquire: async (generation, leaseId, until) =>
        orThrow(await store.tryAcquire(generation, leaseId, until)),
      commit: async (generation, leaseId, credential) =>
        orThrow(await store.commit(generation, leaseId, credential)),
      release: async (generation, leaseId) => {
        orThrow(await store.release(generation, leaseId));
      },
    };
  }

  private async revoke(refreshToken: string): Promise<Error | undefined> {
    const response = await this.fetchFn(REVOKE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        originator: this.attribution.originator,
        "User-Agent": this.attribution.userAgent,
      },
      body: JSON.stringify({
        token: refreshToken,
        token_type_hint: "refresh_token",
        client_id: CLIENT_ID,
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch(
      (cause: unknown) =>
        new Error("Не удалось отозвать refresh-токен", { cause }),
    );
    if (response instanceof Error) return response;

    await response.body?.cancel();
    if (!response.ok)
      return new Error(
        `Не удалось отозвать refresh-токен: HTTP ${response.status}`,
      );
  }
}

function usableCredential(
  state: StoredAuthState,
): NotLoggedInError | ReauthRequiredError | OpenAISubscriptionCredential {
  if (!state.credential) return new NotLoggedInError();
  if (state.reauth) return new ReauthRequiredError(state.reauth);
  return state.credential;
}

/** Rethrows an error value where a third-party contract expects exceptions. */
function orThrow<T>(value: T): Exclude<T, Error> {
  if (value instanceof Error) throw value;
  return value as Exclude<T, Error>;
}

function accountInfo(
  credential: OpenAISubscriptionCredential,
  refreshedAt: number | null,
): AccountInfo {
  return {
    accountId: credential.accountId,
    email: emailFromAccessToken(credential.accessToken),
    planType: planTypeFromAccessToken(credential.accessToken),
    expiresAt: credential.expiresAt,
    refreshedAt,
  };
}

function emailFromAccessToken(accessToken: string): string | null {
  try {
    const payload = JSON.parse(
      Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString(
        "utf8",
      ),
    );
    const email =
      payload?.["https://api.openai.com/profile"]?.email ?? payload?.email;
    return typeof email === "string" ? email : null;
  } catch {
    return null;
  }
}
