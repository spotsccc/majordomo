/**
 * Conversations with the owner, their history and agent turns in Postgres
 * (`chat` schema of `@repo/db`). Telegram is the only channel so far.
 *
 * Transaction callbacks throw on failure, as `db.transaction` requires: that
 * rolls the transaction back, and the caller gets the error as a value.
 */
import { conversations, messages, turns } from "@repo/db";
import { safeValidateUIMessages, type UIMessage } from "ai";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { db } from "./db";

/**
 * How long a turn may run: the webhook's `maxDuration` (300 s) plus a margin.
 * A turn still `processing` after it is lost: its function instance is gone.
 */
const TURN_DEADLINE_MS = 330_000;

/** How many last messages of a conversation the agent sees. */
const HISTORY_LIMIT = 50;

/**
 * The id of the open conversation in a Telegram chat, opening one if there is
 * none. A single upsert on the partial unique index of open conversations, so
 * two first messages arriving at once still share one conversation; the no-op
 * update makes Postgres return the existing row.
 */
export async function openTelegramConversation(
  threadId: string,
): Promise<Error | string> {
  const rows = await db
    .insert(conversations)
    .values({ channel: "telegram", externalId: threadId })
    .onConflictDoUpdate({
      target: [conversations.channel, conversations.externalId],
      targetWhere: isNull(conversations.closedAt),
      set: { externalId: threadId },
    })
    .returning({ id: conversations.id })
    .catch(
      (cause: unknown) =>
        new Error("Не удалось открыть диалог в базе", { cause }),
    );
  if (rows instanceof Error) return rows;
  return rows[0]!.id;
}

/**
 * Closes the open conversation of a Telegram chat (`/new`): the next message
 * opens a new one, and the closed one keeps its history. Does nothing when
 * the chat has no open conversation.
 */
export async function closeTelegramConversation(
  threadId: string,
): Promise<Error | undefined> {
  const closed = await db
    .update(conversations)
    .set({ closedAt: new Date() })
    .where(
      and(
        eq(conversations.channel, "telegram"),
        eq(conversations.externalId, threadId),
        isNull(conversations.closedAt),
      ),
    )
    .catch(
      (cause: unknown) =>
        new Error("Не удалось закрыть диалог в базе", { cause }),
    );
  if (closed instanceof Error) return closed;
}

/**
 * Starts a turn over new messages of the owner, one message or a series
 * collected while the previous turn ran. In one transaction writes the turn
 * as `processing` and the messages in their order, so a message is never
 * saved without a turn that answers it. Returns the turn id.
 *
 * `started_at` and `deadline_at` come from the application clock, not from
 * `now()` of Postgres: `reportLostTurns` compares the deadline with the same
 * clock.
 */
export async function beginTurn(
  conversationId: string,
  ownerMessages: [UIMessage, ...UIMessage[]],
): Promise<Error | string> {
  const startedAt = new Date();
  return db
    .transaction(async (tx) => {
      const [turn] = await tx
        .insert(turns)
        .values({
          conversationId,
          status: "processing",
          startedAt,
          deadlineAt: new Date(startedAt.getTime() + TURN_DEADLINE_MS),
        })
        .returning({ id: turns.id });
      await tx
        .insert(messages)
        .values(
          ownerMessages.map((uiMessage) => ({ conversationId, uiMessage })),
        );
      return turn!.id;
    })
    .catch(
      (cause: unknown) => new Error("Не удалось начать ход в базе", { cause }),
    );
}

/**
 * Finishes a turn with the agent's answer. In one transaction appends the
 * answer to the history and marks the turn `done`, so an answered turn never
 * looks lost.
 */
export async function finishTurn(
  turnId: string,
  answer: UIMessage,
): Promise<Error | undefined> {
  const finished = await db
    .transaction(async (tx) => {
      const [turn] = await tx
        .update(turns)
        .set({ status: "done" })
        .where(eq(turns.id, turnId))
        .returning({ conversationId: turns.conversationId });
      if (!turn) throw new Error(`Хода ${turnId} нет в базе`);
      await tx
        .insert(messages)
        .values({ conversationId: turn.conversationId, uiMessage: answer });
    })
    .catch(
      (cause: unknown) =>
        new Error("Не удалось завершить ход в базе", { cause }),
    );
  if (finished instanceof Error) return finished;
}

/** Marks a turn `failed` and keeps why, for diagnosis; the owner never sees it. */
export async function failTurn(
  turnId: string,
  error: Error,
): Promise<Error | undefined> {
  const failed = await db
    .update(turns)
    .set({ status: "failed", error: String(error) })
    .where(eq(turns.id, turnId))
    .catch(
      (cause: unknown) =>
        new Error("Не удалось отметить сбой хода в базе", { cause }),
    );
  if (failed instanceof Error) return failed;
}

/**
 * Marks a turn `awaiting_login`: it stopped because the ChatGPT session is
 * missing or dead and waits for the owner to log in. Such a turn is not lost.
 */
export async function awaitLogin(turnId: string): Promise<Error | undefined> {
  const marked = await db
    .update(turns)
    .set({ status: "awaiting_login" })
    .where(eq(turns.id, turnId))
    .catch(
      (cause: unknown) =>
        new Error("Не удалось отметить ожидание входа в базе", { cause }),
    );
  if (marked instanceof Error) return marked;
}

/**
 * Lost turns: still `processing` after their deadline because their function
 * instance died. Marks them reported and returns each with the chat to tell
 * the owner in. A lost turn is returned once, even to concurrent callers, so
 * the owner is told at most once: if telling fails, it is not retried.
 */
export async function reportLostTurns(): Promise<
  Error | { turnId: string; threadId: string }[]
> {
  const now = new Date();
  return db
    .update(turns)
    .set({ reportedAt: now })
    .from(conversations)
    .where(
      and(
        eq(turns.conversationId, conversations.id),
        eq(turns.status, "processing"),
        lt(turns.deadlineAt, now),
        isNull(turns.reportedAt),
      ),
    )
    .returning({ turnId: turns.id, threadId: conversations.externalId })
    .catch(
      (cause: unknown) =>
        new Error("Не удалось найти потерянные ходы в базе", { cause }),
    );
}

/**
 * The last `HISTORY_LIMIT` messages of a conversation, oldest first. Stored
 * JSON is checked against the AI SDK message schema, so a damaged row is an
 * error rather than a malformed message for the model. The schema rejects an
 * empty list, so an empty history skips the check.
 */
export async function loadHistory(
  conversationId: string,
): Promise<Error | UIMessage[]> {
  const rows = await db
    .select({ uiMessage: messages.uiMessage })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.seq))
    .limit(HISTORY_LIMIT)
    .catch(
      (cause: unknown) =>
        new Error("Не удалось прочитать историю диалога из базы", { cause }),
    );
  if (rows instanceof Error) return rows;
  if (rows.length === 0) return [];

  const validated = await safeValidateUIMessages({
    messages: rows.map((row) => row.uiMessage).reverse(),
  });
  if (!validated.success) {
    return new Error("История диалога в базе повреждена", {
      cause: validated.error,
    });
  }
  return validated.data;
}
