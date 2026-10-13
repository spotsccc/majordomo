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

const ID = "default";

/** Changing it makes saved tokens unreadable. */
const CREDENTIAL_AAD = `auth.openai_credentials:${ID}`;

/** Changing it makes a login in progress unreadable. */
const DEVICE_LOGIN_AAD = `auth.openai_device_logins:${ID}`;

/**
 * `SELECT ... FOR UPDATE` on the row gives the lease protocol the same guarantees as the file
 * lock.
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
   * A credential sealed with a lost or rotated-out key reads as logged out (`undecryptable`),
   * so a new login can overwrite it instead of the owner cleaning the table by hand.
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
