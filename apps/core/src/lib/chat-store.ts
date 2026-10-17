import { conversations, messages, turns } from "@repo/db";
import { safeValidateUIMessages, type UIMessage } from "ai";
import {
  and,
  asc,
  count,
  desc,
  eq,
  isNull,
  lt,
  max,
  sql,
  type SQL,
} from "drizzle-orm";
import { db, type Tx } from "./db";

/** The webhook's `maxDuration` (300 s) plus a margin. */
const TURN_DEADLINE_MS = 330_000;

const HISTORY_LIMIT = 50;

const UNPROCESSED_KEPT = 10;

const PART_MAX = 200;

const afterCursor = sql`${messages.seq} > coalesce(${conversations.summaryThroughSeq}, 0)`;

export const messageText: SQL<string> = sql<string>`array_to_string(array(select jsonb_array_elements_text(jsonb_path_query_array(${messages.uiMessage}, '$.parts[*] ? (@.type == "text").text'))), E'\n\n')`;

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
): Promise<Error | string | undefined> {
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
    .returning({ id: conversations.id })
    .catch(
      (cause: unknown) =>
        new Error("Не удалось закрыть диалог в базе", { cause }),
    );
  if (closed instanceof Error) return closed;
  return closed[0]?.id;
}

export async function lastMessageAt(
  threadId: string,
): Promise<
  Error | { conversationId: string; title: string | null; at: Date } | null
> {
  const rows = await db
    .select({
      conversationId: conversations.id,
      title: conversations.title,
      at: max(messages.createdAt),
    })
    .from(conversations)
    .innerJoin(messages, eq(messages.conversationId, conversations.id))
    .where(
      and(
        eq(conversations.channel, "telegram"),
        eq(conversations.externalId, threadId),
        isNull(conversations.closedAt),
      ),
    )
    .groupBy(conversations.id)
    .catch(
      (cause: unknown) =>
        new Error("Не удалось прочитать последнее сообщение диалога", {
          cause,
        }),
    );
  if (rows instanceof Error) return rows;
  const [last] = rows;
  return last?.at
    ? { conversationId: last.conversationId, title: last.title, at: last.at }
    : null;
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

/**
 * The summary stands for the messages up to the cursor, so only the later ones follow it, and no
 * more than 50 even when the processing lags behind (П16, E12). The AI SDK schema rejects an empty
 * list, so an empty history skips the check.
 */
export async function loadHistory(
  conversationId: string,
): Promise<Error | { summary: string | null; messages: UIMessage[] }> {
  const rows = await db
    .select({ summary: conversations.summary, uiMessage: messages.uiMessage })
    .from(conversations)
    .leftJoin(
      messages,
      and(eq(messages.conversationId, conversations.id), afterCursor),
    )
    .where(eq(conversations.id, conversationId))
    .orderBy(desc(messages.seq))
    .limit(HISTORY_LIMIT)
    .catch(
      (cause: unknown) =>
        new Error("Не удалось прочитать историю диалога из базы", { cause }),
    );
  if (rows instanceof Error) return rows;
  const summary = rows[0]?.summary ?? null;
  const history = rows.flatMap((row) => (row.uiMessage ? [row.uiMessage] : []));
  if (history.length === 0) return { summary, messages: [] };

  const validated = await safeValidateUIMessages({
    messages: history.reverse(),
  });
  if (!validated.success) {
    return new Error("История диалога в базе повреждена", {
      cause: validated.error,
    });
  }
  return { summary, messages: validated.data };
}

export async function unprocessedCount(
  conversationId: string,
): Promise<Error | number> {
  const rows = await db
    .select({ unprocessed: count() })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(eq(messages.conversationId, conversationId), afterCursor))
    .catch(
      (cause: unknown) =>
        new Error("Не удалось посчитать необработанные сообщения", { cause }),
    );
  if (rows instanceof Error) return rows;
  return rows[0]?.unprocessed ?? 0;
}

export async function processingPart(
  conversationId: string,
  { whole }: { whole: boolean },
): Promise<
  | Error
  | {
      cursor: number | null;
      summary: string | null;
      messages: {
        id: string;
        seq: number;
        role: string;
        createdAt: Date;
        text: string;
      }[];
    }
> {
  const kept = db
    .select({ seq: messages.seq })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.seq))
    .offset(UNPROCESSED_KEPT - 1)
    .limit(1);
  const rows = await db
    .select({
      cursor: conversations.summaryThroughSeq,
      summary: conversations.summary,
      id: messages.id,
      seq: messages.seq,
      role: sql<string>`${messages.uiMessage}->>'role'`,
      createdAt: messages.createdAt,
      text: messageText,
    })
    .from(conversations)
    .leftJoin(
      messages,
      and(
        eq(messages.conversationId, conversations.id),
        afterCursor,
        whole ? undefined : lt(messages.seq, sql`(${kept})`),
      ),
    )
    .where(eq(conversations.id, conversationId))
    .orderBy(asc(messages.seq))
    .limit(PART_MAX)
    .catch(
      (cause: unknown) =>
        new Error("Не удалось прочитать часть диалога для обработки", {
          cause,
        }),
    );
  if (rows instanceof Error) return rows;
  const [first] = rows;
  if (!first) return new Error(`Диалога ${conversationId} нет в базе`);
  return {
    cursor: first.cursor,
    summary: first.summary,
    messages: rows.flatMap(({ id, seq, role, createdAt, text }) =>
      id !== null && seq !== null && createdAt !== null
        ? [{ id, seq, role, createdAt, text }]
        : [],
    ),
  };
}

/**
 * The cursor moves only from the value the processing read, so of two concurrent runs the later
 * one updates nothing and applies nothing (E1). It runs in the transaction of the processing:
 * a failure of the operations after it rolls the cursor back too.
 */
export async function saveSummary(
  tx: Tx,
  conversationId: string,
  {
    title,
    summary,
    throughSeq,
  }: { title: string; summary: string; throughSeq: number },
  from: number | null,
): Promise<boolean> {
  const moved = await tx
    .update(conversations)
    .set({ title, summary, summaryThroughSeq: throughSeq })
    .where(
      and(
        eq(conversations.id, conversationId),
        from === null
          ? isNull(conversations.summaryThroughSeq)
          : eq(conversations.summaryThroughSeq, from),
      ),
    )
    .returning({ id: conversations.id });
  return moved.length > 0;
}
