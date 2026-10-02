import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OpenAISubscriptionCredential } from "@fieldwork-ai/codex-transport";

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
  load(): Promise<StoredAuthState>;
  tryAcquire(
    expectedGeneration: number,
    leaseId: string,
    leaseUntil: number,
  ): Promise<boolean>;
  commit(
    expectedGeneration: number,
    leaseId: string,
    credential: OpenAISubscriptionCredential,
  ): Promise<boolean>;
  release(expectedGeneration: number, leaseId: string): Promise<void>;
  /** Login (a credential) or logout (null): replaces everything unconditionally. */
  replace(
    credential: OpenAISubscriptionCredential | null,
  ): Promise<StoredAuthState>;
  /** Records a permanent refresh failure unless another writer has moved on. */
  markReauthRequired(
    expectedGeneration: number,
    info: ReauthInfo,
  ): Promise<boolean>;
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

  protected abstract read(): Promise<PersistedState>;

  /** Runs `change` atomically; a returned state is persisted. */
  protected abstract mutate<T>(
    change: (state: PersistedState) => { next?: PersistedState; result: T },
  ): Promise<T>;

  async load(): Promise<StoredAuthState> {
    const { lease: _lease, ...state } = await this.read();
    return state;
  }

  tryAcquire(
    expectedGeneration: number,
    leaseId: string,
    leaseUntil: number,
  ): Promise<boolean> {
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
  ): Promise<boolean> {
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

  release(expectedGeneration: number, leaseId: string): Promise<void> {
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
  ): Promise<StoredAuthState> {
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
  ): Promise<boolean> {
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

  protected async read(): Promise<PersistedState> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return structuredClone(EMPTY_STATE);
      throw error;
    }
    return parseState(text, this.path);
  }

  protected async mutate<T>(
    change: (state: PersistedState) => { next?: PersistedState; result: T },
  ): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const unlock = await this.lock();
    try {
      const { next, result } = change(await this.read());
      if (next) await this.write(next);
      return result;
    } finally {
      await unlock();
    }
  }

  private async write(state: PersistedState): Promise<void> {
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(
        `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`,
      );
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  private async lock(): Promise<() => Promise<void>> {
    const deadline = Date.now() + this.lockTimeoutMs;
    const token = randomUUID();
    while (true) {
      try {
        const file = await open(this.lockPath, "wx", 0o600);
        try {
          await file.writeFile(token);
        } finally {
          await file.close();
        }
        return async () => {
          // Do not remove a lock that was taken over after ours went stale.
          const owner = await readFile(this.lockPath, "utf8").catch(
            () => undefined,
          );
          if (owner === token) await unlink(this.lockPath).catch(() => {});
        };
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
      }
      await this.removeStaleLock();
      if (Date.now() >= deadline) {
        throw new Error(
          `Не удалось заблокировать ${this.path}: файл ${this.lockPath} занят`,
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, 10 + Math.random() * 20),
      );
    }
  }

  private async removeStaleLock(): Promise<void> {
    try {
      const info = await stat(this.lockPath);
      if (Date.now() - info.mtimeMs > this.staleLockMs)
        await unlink(this.lockPath);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }
}

function parseState(text: string, path: string): PersistedState {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Файл ${path} повреждён: это не JSON`);
  }
  if (
    !isObject(value) ||
    value.version !== 1 ||
    typeof value.generation !== "number"
  ) {
    throw new Error(`Файл ${path} имеет неизвестный формат`);
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
