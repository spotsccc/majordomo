import { conversations, messages, turns } from "@repo/db";
import { safeValidateUIMessages, type UIMessage } from "ai";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { db } from "./db";

/** The webhook's `maxDuration` (300 s) plus a margin. */
const TURN_DEADLINE_MS = 330_000;

const HISTORY_LIMIT = 50;

/**
 * The partial unique index keeps two simultaneous first messages in one conversation; the no-op
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
 * `started_at` and `deadline_at` come from the application clock, not Postgres `now()`:
 * `reportLostTurns` compares the deadline with the same clock.
 */
export async function beginTurn(
  conversationId: string,
  ownerMessages: [UIMessage, ...UIMessage[]],
): Promise<Error | { turnId: string; ownerMessageId: string }> {
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
      const inserted = await tx
        .insert(messages)
        .values(
          ownerMessages.map((uiMessage) => ({ conversationId, uiMessage })),
        )
        .returning({ id: messages.id, seq: messages.seq });
      const last = inserted.reduce<(typeof inserted)[number] | undefined>(
        (latest, row) => (latest && latest.seq > row.seq ? latest : row),
        undefined,
      );
      if (!turn || !last) throw new Error("INSERT хода не вернул строки");
      return { turnId: turn.id, ownerMessageId: last.id };
    })
    .catch(
      (cause: unknown) => new Error("Не удалось начать ход в базе", { cause }),
    );
}

export async function finishTurn(
  turnId: string,
  answer: UIMessage,
): Promise<Error | undefined> {
  return endTurn(
    turnId,
    { status: "done" },
    answer,
    "Не удалось завершить ход в базе",
  );
}

/** `answer` keeps the tool calls that ran before the failure, so a repeated message does not repeat them. */
export async function failTurn(
  turnId: string,
  error: Error,
  answer?: UIMessage,
): Promise<Error | undefined> {
  return endTurn(
    turnId,
    { status: "failed", error: String(error) },
    answer,
    "Не удалось отметить сбой хода в базе",
  );
}

export async function awaitLogin(
  turnId: string,
  answer?: UIMessage,
): Promise<Error | undefined> {
  return endTurn(
    turnId,
    { status: "awaiting_login" },
    answer,
    "Не удалось отметить ожидание входа в базе",
  );
}

async function endTurn(
  turnId: string,
  set: Pick<typeof turns.$inferInsert, "status" | "error">,
  answer: UIMessage | undefined,
  failure: string,
): Promise<Error | undefined> {
  const ended = await db
    .transaction(async (tx) => {
      const [turn] = await tx
        .update(turns)
        .set(set)
        .where(eq(turns.id, turnId))
        .returning({ conversationId: turns.conversationId });
      if (!turn) throw new Error(`Хода ${turnId} нет в базе`);
      if (answer) {
        await tx
          .insert(messages)
          .values({ conversationId: turn.conversationId, uiMessage: answer });
      }
    })
    .catch((cause: unknown) => new Error(failure, { cause }));
  if (ended instanceof Error) return ended;
}

/**
 * A lost turn is returned once, even to concurrent callers, so the owner is told at most once:
 * a failed notice is not retried.
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

/** The AI SDK schema rejects an empty list, so an empty history skips the check. */
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
