import { changes, conversations, core, entries, messages } from "@repo/db";
import type { Turn } from "../capability";
import { db, pool } from "../db";

/** Memory rows point at chat messages, so they go before any cleanup of `chat`. */
export async function resetMemory(): Promise<void> {
  await db.delete(changes);
  await db.delete(entries);
  await db.delete(core);
}

export async function ownerTurn(text: string, createdAt?: Date): Promise<Turn> {
  const [conversation] = await db
    .insert(conversations)
    .values({
      channel: "telegram",
      externalId: `telegram:${crypto.randomUUID()}`,
    })
    .returning({ id: conversations.id });
  if (!conversation) throw new Error("Диалог не создан");
  const messageId = await insertMessage(
    conversation.id,
    "user",
    text,
    createdAt,
  );
  return { conversationId: conversation.id, messageId };
}

/** Owner and agent take turns, the owner first. */
export async function conversationOf(
  count: number,
  { createdAt, closed = false }: { createdAt?: Date; closed?: boolean } = {},
): Promise<{ id: string; messages: { id: string; seq: number }[] }> {
  const [conversation] = await db
    .insert(conversations)
    .values({
      channel: "telegram",
      externalId: `telegram:${crypto.randomUUID()}`,
      closedAt: closed ? new Date() : null,
    })
    .returning({ id: conversations.id });
  if (!conversation) throw new Error("Диалог не создан");
  const inserted = await db
    .insert(messages)
    .values(
      Array.from({ length: count }, (_, index) => ({
        conversationId: conversation.id,
        uiMessage: {
          id: crypto.randomUUID(),
          role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
          parts: [{ type: "text" as const, text: `Реплика ${index + 1}` }],
        },
        createdAt,
      })),
    )
    .returning({ id: messages.id, seq: messages.seq });
  return {
    id: conversation.id,
    messages: inserted.sort((a, b) => a.seq - b.seq),
  };
}

export async function insertMessage(
  conversationId: string,
  role: "user" | "assistant",
  text: string,
  createdAt?: Date,
): Promise<string> {
  const [message] = await db
    .insert(messages)
    .values({
      conversationId,
      uiMessage: {
        id: crypto.randomUUID(),
        role,
        parts: [{ type: "text", text }],
      },
      createdAt,
    })
    .returning({ id: messages.id });
  if (!message) throw new Error("Сообщение не записано");
  return message.id;
}

/**
 * Polls instead of waiting a fixed time: the test goes on as soon as the transactions queue up. The
 * pause is `pg_sleep`, not `setTimeout`: a test with fake timers waits for locks too.
 */
export async function waitingLocks(count: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ waiting: number }>(
      "select count(*)::int as waiting from pg_locks where not granted",
    );
    if ((rows[0]?.waiting ?? 0) >= count) return;
    await pool.query("select pg_sleep(0.01)");
  }
  throw new Error(`За 5 с не дождались ${count} ожидающих блокировок`);
}
