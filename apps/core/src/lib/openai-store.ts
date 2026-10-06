/**
 * The owner's ChatGPT session and device login in Postgres (`auth` schema of
 * `@repo/db`), shared by every function instance. Secrets are sealed with
 * the `SecretBox` from `config`, bound to their table and row.
 */
import { openaiCredentials, openaiDeviceLogins } from "@repo/db";
import {
  EMPTY_STATE,
  StateCredentialStore,
  type OpenAISubscriptionCredential,
  type PendingDeviceLogin,
  type PersistedState,
} from "@repo/openai-subscription";
import { eq } from "drizzle-orm";
import { config } from "./config";
import { db } from "./db";

/** The owner's row in both tables: there is one owner. */
const ID = "default";

/** `SecretBox` AAD of the sealed credential. Changing it makes saved tokens unreadable. */
const CREDENTIAL_AAD = `auth.openai_credentials:${ID}`;

/** `SecretBox` AAD of the sealed pending login. Changing it makes a login in progress unreadable. */
const DEVICE_LOGIN_AAD = `auth.openai_device_logins:${ID}`;

/**
 * ChatGPT subscription credentials in Postgres. Each change runs in a
 * transaction on the row locked with `SELECT ... FOR UPDATE`, which gives the
 * lease protocol of `StateCredentialStore` (the store contract of
 * `@repo/openai-subscription`) the same guarantees as the file lock.
 */
export class PostgresCredentialStore extends StateCredentialStore {
  protected async read(): Promise<Error | PersistedState> {
    const rows = await db
      .select()
      .from(openaiCredentials)
      .where(eq(openaiCredentials.id, ID))
      .catch(
        (cause: unknown) =>
          new Error("Не удалось прочитать токены ChatGPT из базы", { cause }),
      );
    if (rows instanceof Error) return rows;

    const [row] = rows;
    return row ? this.toState(row) : structuredClone(EMPTY_STATE);
  }

  /**
   * Creates the row if it is missing, locks it and applies `change`. The
   * transaction callback throws on failure, as `db.transaction` requires:
   * that rolls the transaction back.
   */
  protected mutate<T>(
    change: (state: PersistedState) => { next?: PersistedState; result: T },
  ): Promise<Error | T> {
    return db
      .transaction(async (tx) => {
        await tx
          .insert(openaiCredentials)
          .values({ id: ID })
          .onConflictDoNothing();
        const [row] = await tx
          .select()
          .from(openaiCredentials)
          .where(eq(openaiCredentials.id, ID))
          .for("update");
        const { next, result } = change(this.toState(row!));
        if (next) {
          await tx
            .update(openaiCredentials)
            .set(this.toRow(next))
            .where(eq(openaiCredentials.id, ID));
        }
        return result;
      })
      .catch(
        (cause: unknown) =>
          new Error("Не удалось обновить токены ChatGPT в базе", { cause }),
      );
  }

  /**
   * A credential sealed with a key we no longer have (lost or rotated out)
   * reads as "not logged in" with reauth code `undecryptable`, so a new login
   * can overwrite it. Otherwise the owner could never log in again without
   * cleaning the table by hand.
   */
  private toState(row: typeof openaiCredentials.$inferSelect): PersistedState {
    const credential = row.credential
      ? config.SECRETS_ENCRYPTION_KEYS.openJson<OpenAISubscriptionCredential>(
          row.credential,
          CREDENTIAL_AAD,
        )
      : null;
    const unreadable = credential instanceof Error;
    return {
      generation: row.generation,
      credential: unreadable ? null : credential,
      refreshedAt: row.refreshedAt?.getTime() ?? null,
      reauth: unreadable
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

  private toRow(state: PersistedState) {
    return {
      generation: state.generation,
      credential: state.credential
        ? config.SECRETS_ENCRYPTION_KEYS.sealJson(
            state.credential,
            CREDENTIAL_AAD,
          )
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

/**
 * The device login in progress, kept between serverless invocations; null
 * when there is none or its code has expired.
 */
export async function getDeviceLogin(): Promise<
  Error | PendingDeviceLogin | null
> {
  const rows = await db
    .select()
    .from(openaiDeviceLogins)
    .where(eq(openaiDeviceLogins.id, ID))
    .catch(
      (cause: unknown) =>
        new Error("Не удалось прочитать вход по коду из базы", { cause }),
    );
  if (rows instanceof Error) return rows;

  const [row] = rows;
  if (!row || row.expiresAt.getTime() <= Date.now()) return null;
  return config.SECRETS_ENCRYPTION_KEYS.openJson<PendingDeviceLogin>(
    row.pending,
    DEVICE_LOGIN_AAD,
  );
}

/** Saves a started device login in place of the previous one. */
export async function saveDeviceLogin(
  pending: PendingDeviceLogin,
): Promise<Error | undefined> {
  const values = {
    pending: config.SECRETS_ENCRYPTION_KEYS.sealJson(pending, DEVICE_LOGIN_AAD),
    expiresAt: new Date(pending.expiresAt),
    createdAt: new Date(),
  };
  const saved = await db
    .insert(openaiDeviceLogins)
    .values({ id: ID, ...values })
    .onConflictDoUpdate({ target: openaiDeviceLogins.id, set: values })
    .catch(
      (cause: unknown) =>
        new Error("Не удалось сохранить вход по коду в базе", { cause }),
    );
  if (saved instanceof Error) return saved;
}

/** Forgets the device login in progress, if there is one. */
export async function clearDeviceLogin(): Promise<Error | undefined> {
  const cleared = await db
    .delete(openaiDeviceLogins)
    .where(eq(openaiDeviceLogins.id, ID))
    .catch(
      (cause: unknown) =>
        new Error("Не удалось удалить вход по коду из базы", { cause }),
    );
  if (cleared instanceof Error) return cleared;
}
