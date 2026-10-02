import {
  EMPTY_STATE,
  StateCredentialStore,
  type OpenAISubscriptionCredential,
  type PendingDeviceLogin,
  type PersistedState,
} from "@repo/openai-subscription";
import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { openaiCredentials, openaiDeviceLogins } from "./schema/auth.ts";
import type { SecretBox } from "./secret-box.ts";

const UNREADABLE = Symbol("unreadable");

// Works with any drizzle Postgres driver: node-postgres in the app, PGlite in tests.
type AnyDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * ChatGPT subscription credentials in Postgres, shared by every function
 * instance. Each change runs in a transaction on the row locked with
 * `SELECT ... FOR UPDATE`, which gives the lease protocol of
 * `StateCredentialStore` the same guarantees as the file lock. Tokens are
 * sealed with SecretBox; without the key the store cannot read or write them.
 */
export class PostgresCredentialStore extends StateCredentialStore {
  private readonly db: AnyDatabase;
  private readonly box: SecretBox;
  private readonly id: string;

  constructor(
    db: AnyDatabase,
    box: SecretBox,
    id = "default",
    now?: () => number,
  ) {
    super(now);
    this.db = db;
    this.box = box;
    this.id = id;
  }

  protected async read(): Promise<PersistedState> {
    const [row] = await this.db
      .select()
      .from(openaiCredentials)
      .where(eq(openaiCredentials.id, this.id));
    return row ? this.toState(row) : structuredClone(EMPTY_STATE);
  }

  protected mutate<T>(
    change: (state: PersistedState) => { next?: PersistedState; result: T },
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx
        .insert(openaiCredentials)
        .values({ id: this.id })
        .onConflictDoNothing();
      const [row] = await tx
        .select()
        .from(openaiCredentials)
        .where(eq(openaiCredentials.id, this.id))
        .for("update");
      const { next, result } = change(this.toState(row!));
      if (next) {
        await tx
          .update(openaiCredentials)
          .set(this.toRow(next))
          .where(eq(openaiCredentials.id, this.id));
      }
      return result;
    });
  }

  private get aad(): string {
    return `auth.openai_credentials:${this.id}`;
  }

  private toState(row: typeof openaiCredentials.$inferSelect): PersistedState {
    const credential = row.credential ? this.open(row.credential) : null;
    return {
      generation: row.generation,
      credential: credential === UNREADABLE ? null : credential,
      refreshedAt: row.refreshedAt?.getTime() ?? null,
      reauth:
        credential === UNREADABLE
          ? {
              reason:
                "токены зашифрованы другим ключом (сменился SECRETS_ENCRYPTION_KEYS?)",
              code: "undecryptable",
              at: this.now(),
            }
          : (row.reauth ?? null),
      lease:
        row.leaseId && row.leaseUntil
          ? { id: row.leaseId, until: row.leaseUntil.getTime() }
          : null,
    };
  }

  /**
   * A credential sealed with a key we no longer have (lost or rotated out) reads
   * as "not logged in", so a new login can overwrite it. Otherwise the owner
   * could never log in again without cleaning the table by hand.
   */
  private open(
    sealed: string,
  ): OpenAISubscriptionCredential | typeof UNREADABLE {
    try {
      return this.box.openJson<OpenAISubscriptionCredential>(sealed, this.aad);
    } catch {
      return UNREADABLE;
    }
  }

  private toRow(state: PersistedState) {
    return {
      generation: state.generation,
      credential: state.credential
        ? this.box.sealJson(state.credential, this.aad)
        : null,
      refreshedAt:
        state.refreshedAt === null ? null : new Date(state.refreshedAt),
      reauth: state.reauth,
      leaseId: state.lease?.id ?? null,
      leaseUntil: state.lease ? new Date(state.lease.until) : null,
      updatedAt: new Date(),
    };
  }
}

/** The one device login in progress, kept between serverless invocations. */
export class PostgresDeviceLoginStore {
  private readonly db: AnyDatabase;
  private readonly box: SecretBox;
  private readonly id: string;

  constructor(db: AnyDatabase, box: SecretBox, id = "default") {
    this.db = db;
    this.box = box;
    this.id = id;
  }

  private get aad(): string {
    return `auth.openai_device_logins:${this.id}`;
  }

  /** The pending login, or null if there is none or it has expired. */
  async get(now = Date.now()): Promise<PendingDeviceLogin | null> {
    const [row] = await this.db
      .select()
      .from(openaiDeviceLogins)
      .where(eq(openaiDeviceLogins.id, this.id));
    if (!row || row.expiresAt.getTime() <= now) return null;
    return this.box.openJson<PendingDeviceLogin>(row.pending, this.aad);
  }

  async save(pending: PendingDeviceLogin): Promise<void> {
    const values = {
      pending: this.box.sealJson(pending, this.aad),
      expiresAt: new Date(pending.expiresAt),
      createdAt: new Date(),
    };
    await this.db
      .insert(openaiDeviceLogins)
      .values({ id: this.id, ...values })
      .onConflictDoUpdate({ target: openaiDeviceLogins.id, set: values });
  }

  async clear(): Promise<void> {
    await this.db
      .delete(openaiDeviceLogins)
      .where(eq(openaiDeviceLogins.id, this.id));
  }
}
