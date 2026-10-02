import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OpenAISubscriptionCredential } from "@fieldwork-ai/codex-transport";
import { tryAsync, tryFn } from "@spotsccc/error-as-value";

/** Why the saved session can no longer be refreshed and needs a new login. */
export interface ReauthInfo {
  reason: string;
  code?: string;
  at: number;
}

export interface StoredAuthState {
  /** Incremented on every refresh, login and logout. */
  generation: number;
  credential: OpenAISubscriptionCredential | null;
  /** When the current credential was obtained or last refreshed, in ms. */
  refreshedAt: number | null;
  /** Set once a refresh fails permanently; cleared by the next login. */
  reauth: ReauthInfo | null;
}

/**
 * Durable credential storage shared by every process that uses the subscription.
 *
 * `tryAcquire`, `commit` and `release` implement the lease protocol of
 * `refreshWithCredentialLease` from `@fieldwork-ai/codex-transport`: only the
 * lease holder may commit, and only against the generation it started from.
 * Refresh tokens rotate, so two parallel refreshes would invalidate each other.
 */
export interface CredentialStore {
  load(): Promise<Error | StoredAuthState>;
  tryAcquire(
    expectedGeneration: number,
    leaseId: string,
    leaseUntil: number,
  ): Promise<Error | boolean>;
  commit(
    expectedGeneration: number,
    leaseId: string,
    credential: OpenAISubscriptionCredential,
  ): Promise<Error | boolean>;
  release(
    expectedGeneration: number,
    leaseId: string,
  ): Promise<Error | undefined>;
  /** Login (a credential) or logout (null): replaces everything unconditionally. */
  replace(
    credential: OpenAISubscriptionCredential | null,
  ): Promise<Error | StoredAuthState>;
  /** Records a permanent refresh failure unless another writer has moved on. */
  markReauthRequired(
    expectedGeneration: number,
    info: ReauthInfo,
  ): Promise<Error | boolean>;
}

export interface Lease {
  id: string;
  until: number;
}

/** Everything a store keeps, including the refresh lease. */
export interface PersistedState extends StoredAuthState {
  lease: Lease | null;
}

export const EMPTY_STATE: PersistedState = {
  generation: 0,
  credential: null,
  refreshedAt: null,
  reauth: null,
  lease: null,
};

/**
 * Implements the store protocol on top of two primitives: read and atomic
 * read-modify-write. Extend it to keep credentials elsewhere, e.g. in a database.
 */
export abstract class StateCredentialStore implements CredentialStore {
  protected readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  protected abstract read(): Promise<Error | PersistedState>;

  /** Runs `change` atomically; a returned state is persisted. */
  protected abstract mutate<T>(
    change: (state: PersistedState) => { next?: PersistedState; result: T },
  ): Promise<Error | T>;

  async load(): Promise<Error | StoredAuthState> {
    const persisted = await this.read();
    if (persisted instanceof Error) return persisted;

    const { lease: _lease, ...state } = persisted;
    return state;
  }

  tryAcquire(
    expectedGeneration: number,
    leaseId: string,
    leaseUntil: number,
  ): Promise<Error | boolean> {
    return this.mutate((state) => {
      if (state.generation !== expectedGeneration || !state.credential)
        return { result: false };
      if (
        state.lease &&
        state.lease.until > this.now() &&
        state.lease.id !== leaseId
      )
        return { result: false };
      return {
        next: { ...state, lease: { id: leaseId, until: leaseUntil } },
        result: true,
      };
    });
  }

  commit(
    expectedGeneration: number,
    leaseId: string,
    credential: OpenAISubscriptionCredential,
  ): Promise<Error | boolean> {
    return this.mutate((state) => {
      // A matching lease id proves nobody took over, even if the lease ran out
      // meanwhile; rejecting now would throw away an already rotated token.
      if (
        state.generation !== expectedGeneration ||
        state.lease?.id !== leaseId
      ) {
        return { result: false };
      }
      return {
        next: {
          generation: state.generation + 1,
          credential,
          refreshedAt: this.now(),
          reauth: null,
          lease: null,
        },
        result: true,
      };
    });
  }

  release(
    expectedGeneration: number,
    leaseId: string,
  ): Promise<Error | undefined> {
    return this.mutate((state) => {
      if (
        state.generation !== expectedGeneration ||
        state.lease?.id !== leaseId
      )
        return { result: undefined };
      return { next: { ...state, lease: null }, result: undefined };
    });
  }

  replace(
    credential: OpenAISubscriptionCredential | null,
  ): Promise<Error | StoredAuthState> {
    return this.mutate((state) => {
      const next: PersistedState = {
        generation: state.generation + 1,
        credential,
        refreshedAt: credential ? this.now() : null,
        reauth: null,
        lease: null,
      };
      const { lease: _lease, ...result } = next;
      return { next, result };
    });
  }

  markReauthRequired(
    expectedGeneration: number,
    info: ReauthInfo,
  ): Promise<Error | boolean> {
    return this.mutate((state) => {
      if (state.generation !== expectedGeneration) return { result: false };
      return { next: { ...state, reauth: info, lease: null }, result: true };
    });
  }
}

/** Keeps credentials in process memory. For tests and short-lived tools. */
export class MemoryCredentialStore extends StateCredentialStore {
  private state: PersistedState = structuredClone(EMPTY_STATE);

  constructor(credential?: OpenAISubscriptionCredential, now?: () => number) {
    super(now);
    if (credential) {
      this.state = {
        ...this.state,
        generation: 1,
        credential,
        refreshedAt: this.now(),
      };
    }
  }

  protected async read(): Promise<PersistedState> {
    return structuredClone(this.state);
  }

  protected async mutate<T>(
    change: (state: PersistedState) => { next?: PersistedState; result: T },
  ): Promise<T> {
    const { next, result } = change(structuredClone(this.state));
    if (next) this.state = structuredClone(next);
    return result;
  }
}

/** `MAJORDOMO_OPENAI_AUTH_FILE`, or `~/.majordomo/openai-subscription.json`. Shared by the server and the CLI. */
export function defaultCredentialFile(): string {
  return (
    process.env.MAJORDOMO_OPENAI_AUTH_FILE ||
    join(homedir(), ".majordomo", "openai-subscription.json")
  );
}

export interface FileCredentialStoreOptions {
  now?: () => number;
  /** A lock file older than this is considered left by a crashed process. */
  staleLockMs?: number;
  /** How long to wait for the lock before failing. */
  lockTimeoutMs?: number;
}

/**
 * Stores credentials in a JSON file (mode 0600) that several processes can share,
 * e.g. the server and the CLI used to log in. Every change happens under a
 * short-lived lock file and is written via rename, so readers never see a torn file.
 */
export class FileCredentialStore extends StateCredentialStore {
  private readonly lockPath: string;
  private readonly staleLockMs: number;
  private readonly lockTimeoutMs: number;

  readonly path: string;

  constructor(path: string, options: FileCredentialStoreOptions = {}) {
    super(options.now);
    this.path = path;
    this.lockPath = `${path}.lock`;
    this.staleLockMs = options.staleLockMs ?? 10_000;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
  }

  protected async read(): Promise<Error | PersistedState> {
    const text = await tryAsync(
      () => readFile(this.path, "utf8"),
      (error) => (isErrno(error, "ENOENT") ? null : error),
    );
    if (text instanceof Error) return text;
    if (text === null) return structuredClone(EMPTY_STATE);

    return parseState(text, this.path);
  }

  protected async mutate<T>(
    change: (state: PersistedState) => { next?: PersistedState; result: T },
  ): Promise<Error | T> {
    const directory = await tryAsync(
      () => mkdir(dirname(this.path), { recursive: true, mode: 0o700 }),
      (error) => error,
    );
    if (directory instanceof Error) return directory;

    const unlock = await this.lock();
    if (unlock instanceof Error) return unlock;

    try {
      const state = await this.read();
      if (state instanceof Error) return state;

      const { next, result } = change(state);
      if (next) {
        const written = await this.write(next);
        if (written instanceof Error) return written;
      }
      return result;
    } finally {
      await unlock();
    }
  }

  private async write(state: PersistedState): Promise<Error | undefined> {
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const written = await tryAsync(
      async () => {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(
            `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`,
          );
          await file.sync();
        } finally {
          await file.close();
        }
      },
      (error) => error,
    );
    if (written instanceof Error) return written;

    const renamed = await tryAsync(
      () => rename(temporary, this.path),
      (error) => error,
    );
    if (renamed instanceof Error) {
      await unlink(temporary).catch(() => {});
      return renamed;
    }
  }

  private async lock(): Promise<Error | (() => Promise<void>)> {
    const deadline = Date.now() + this.lockTimeoutMs;
    const token = randomUUID();
    while (true) {
      const acquired = await tryAsync(
        async () => {
          const file = await open(this.lockPath, "wx", 0o600);
          try {
            await file.writeFile(token);
          } finally {
            await file.close();
          }
        },
        (error) => error,
      );
      if (!(acquired instanceof Error)) {
        return async () => {
          // Do not remove a lock that was taken over after ours went stale.
          const owner = await readFile(this.lockPath, "utf8").catch(
            () => undefined,
          );
          if (owner === token) await unlink(this.lockPath).catch(() => {});
        };
      }
      if (!isErrno(acquired, "EEXIST")) return acquired;

      const removed = await this.removeStaleLock();
      if (removed instanceof Error) return removed;
      if (Date.now() >= deadline) {
        return new Error(
          `Не удалось заблокировать ${this.path}: файл ${this.lockPath} занят`,
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, 10 + Math.random() * 20),
      );
    }
  }

  private async removeStaleLock(): Promise<Error | undefined> {
    const info = await tryAsync(
      () => stat(this.lockPath),
      (error) => error,
    );
    if (info instanceof Error) {
      return isErrno(info, "ENOENT") ? undefined : info;
    }
    if (Date.now() - info.mtimeMs <= this.staleLockMs) return undefined;

    const removed = await tryAsync(
      () => unlink(this.lockPath),
      (error) => error,
    );
    if (removed instanceof Error && !isErrno(removed, "ENOENT")) return removed;
  }
}

function parseState(text: string, path: string): Error | PersistedState {
  const value = tryFn(
    () => JSON.parse(text) as unknown,
    (cause) => new Error(`Файл ${path} повреждён: это не JSON`, { cause }),
  );
  if (value instanceof Error) return value;
  if (
    !isObject(value) ||
    value.version !== 1 ||
    typeof value.generation !== "number"
  ) {
    return new Error(`Файл ${path} имеет неизвестный формат`);
  }
  return {
    generation: value.generation,
    credential: isCredential(value.credential) ? value.credential : null,
    refreshedAt:
      typeof value.refreshedAt === "number" ? value.refreshedAt : null,
    reauth: isObject(value.reauth)
      ? (value.reauth as unknown as ReauthInfo)
      : null,
    lease: isObject(value.lease) ? (value.lease as unknown as Lease) : null,
  };
}

function isCredential(value: unknown): value is OpenAISubscriptionCredential {
  return (
    isObject(value) &&
    typeof value.accessToken === "string" &&
    typeof value.refreshToken === "string" &&
    typeof value.expiresAt === "number" &&
    typeof value.accountId === "string"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === code
  );
}
