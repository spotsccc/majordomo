import { changes, conversations, core, entries, messages } from "@repo/db";
import type { Turn } from "../capability";
import { db } from "../db";

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
