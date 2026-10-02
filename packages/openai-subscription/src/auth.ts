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
import {
  captureOAuthErrors,
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
    Promise<OpenAISubscriptionCredential>
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
  async getCredential(): Promise<OpenAISubscriptionCredential> {
    const state = await this.store.load();
    const credential = usableCredential(state);
    if (this.now() < this.requestDueAt(state, credential)) return credential;
    try {
      return await this.refreshIfCurrent(credential.accessToken);
    } catch (error) {
      // Any temporary trouble (network, a stuck lease holder in another
      // function instance) must not fail a request while the token still works.
      if (
        !(error instanceof ReauthRequiredError) &&
        !(error instanceof NotLoggedInError) &&
        credential.expiresAt > this.now()
      ) {
        this.options.onError?.(error);
        return credential;
      }
      throw error;
    }
  }

  /** Called after the API answered 401 to `staleAccessToken`: refresh unless someone already did. */
  refreshAfterUnauthorized(
    staleAccessToken: string,
  ): Promise<OpenAISubscriptionCredential> {
    return this.refreshIfCurrent(staleAccessToken);
  }

  /** Refreshes right now regardless of expiry. */
  async refreshNow(): Promise<OpenAISubscriptionCredential> {
    const credential = usableCredential(await this.store.load());
    return this.refreshIfCurrent(credential.accessToken);
  }

  async status(): Promise<AuthStatus> {
    const state = await this.store.load();
    if (!state.credential) return { state: "logged_out" };
    return {
      state: state.reauth ? "reauth_required" : "active",
      reauth: state.reauth,
      ...accountInfo(state.credential, state.refreshedAt),
    };
  }

  /** Current subscription limits as reported by ChatGPT. */
  async usage(): Promise<CodexUsageSnapshot> {
    const credential = await this.getCredential();
    return fetchCodexUsage({
      attribution: this.attribution,
      accessToken: credential.accessToken,
      accountId: credential.accountId,
      fetchFn: this.fetchFn,
    });
  }

  /** Saves the credential from a finished login flow and resumes background refresh. */
  async saveLogin(
    credential: OpenAISubscriptionCredential,
  ): Promise<AuthStatus> {
    await this.store.replace(credential);
    this.failures = 0;
    const status = await this.status();
    this.options.onCredentialChanged?.(status);
    if (this.running) this.schedule(0);
    return status;
  }

  /** Forgets the credential and, by default, revokes its refresh token at OpenAI. */
  async logout(options: { revoke?: boolean } = {}): Promise<void> {
    const state = await this.store.load();
    await this.store.replace(null);
    if (state.credential && options.revoke !== false) {
      await this.revoke(state.credential.refreshToken).catch((error: unknown) =>
        this.options.onError?.(error),
      );
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
  ): Promise<RefreshCheck> {
    const state = await this.store.load();
    if (!state.credential) return { state: "logged_out" };
    if (state.reauth) {
      this.reportReauth(state.reauth);
      return { state: "reauth_required", reauth: state.reauth };
    }
    const dueAt = this.keeperDueAt(state, state.credential);
    if (this.now() < dueAt - (options.aheadMs ?? 0)) {
      return { state: "fresh", dueAt };
    }
    try {
      await this.refreshIfCurrent(state.credential.accessToken);
    } catch (error) {
      if (error instanceof ReauthRequiredError) {
        return { state: "reauth_required", reauth: error.info };
      }
      throw error;
    }
    return { state: "refreshed" };
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    let delay: number;
    try {
      const check = await this.refreshIfDue();
      delay =
        check.state === "fresh"
          ? check.dueAt - this.now()
          : check.state === "refreshed"
            ? AFTER_REFRESH_MS
            : // Wait for a login, possibly made by another process such as the CLI.
              LOGGED_OUT_RECHECK_MS;
      this.failures = 0;
    } catch (error) {
      if (error instanceof NotLoggedInError) {
        delay = LOGGED_OUT_RECHECK_MS;
      } else {
        this.failures += 1;
        delay = Math.min(MIN_RETRY_MS * 2 ** (this.failures - 1), MAX_RETRY_MS);
        this.options.onError?.(error);
      }
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
  ): Promise<OpenAISubscriptionCredential> {
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
  ): Promise<OpenAISubscriptionCredential> {
    const before = await this.store.load();
    const current = usableCredential(before);
    if (current.accessToken !== accessToken) return current;
    try {
      const result = await refreshWithCredentialLease({
        store: this.leaseStore(),
        shouldRefresh: (credential) => credential.accessToken === accessToken,
        refresh: (credential) => this.exchangeRefreshToken(credential),
        leaseDurationMs: this.refreshLeaseMs,
        waitTimeoutMs: this.refreshLeaseMs + 15_000,
        pollIntervalMs: this.leasePollIntervalMs,
      });
      if (result.generation !== before.generation) {
        this.options.onCredentialChanged?.(await this.status());
      }
      return result.credential;
    } catch (error) {
      if (!(error instanceof RefreshError) || !error.permanent) throw error;
      // A newer generation means another process refreshed first; the session is fine.
      const after = await this.store.load();
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
      if (await this.store.markReauthRequired(before.generation, info)) {
        this.reportReauth(info);
      }
      throw new ReauthRequiredError(info);
    }
  }

  private async exchangeRefreshToken(
    credential: OpenAISubscriptionCredential,
  ): Promise<OpenAISubscriptionCredential> {
    const capture = captureOAuthErrors(this.fetchFn);
    try {
      return await refreshOpenAISubscriptionCredential(credential, {
        attribution: this.attribution,
        fetchFn: capture.fetchFn,
      });
    } catch (error) {
      throw RefreshError.from(error, capture.last());
    }
  }

  private leaseStore(): OpenAISubscriptionRefreshStore {
    const store = this.store;
    return {
      async read() {
        const state = await store.load();
        return {
          credential: usableCredential(state),
          generation: state.generation,
        };
      },
      tryAcquire: (generation, leaseId, until) =>
        store.tryAcquire(generation, leaseId, until),
      commit: (generation, leaseId, credential) =>
        store.commit(generation, leaseId, credential),
      release: (generation, leaseId) => store.release(generation, leaseId),
    };
  }

  private async revoke(refreshToken: string): Promise<void> {
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
    });
    await response.body?.cancel();
    if (!response.ok)
      throw new Error(
        `Не удалось отозвать refresh-токен: HTTP ${response.status}`,
      );
  }
}

function usableCredential(
  state: StoredAuthState,
): OpenAISubscriptionCredential {
  if (!state.credential) throw new NotLoggedInError();
  if (state.reauth) throw new ReauthRequiredError(state.reauth);
  return state.credential;
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
