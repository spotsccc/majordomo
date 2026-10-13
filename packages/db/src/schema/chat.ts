import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { UIMessage } from "ai";

export const chat = pgSchema("chat");

export const conversations = chat.table(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Plain text rather than a Postgres enum: a new channel then needs no `ALTER TYPE`. */
    channel: text("channel").$type<"telegram">().notNull(),
    /** `thread.id` from Chat SDK. */
    externalId: text("external_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("conversations_open_uq")
      .on(table.channel, table.externalId)
      .where(sql`${table.closedAt} is null`),
  ],
);

export type Voice = {
  /** Downloads the audio again, including after a crash. */
  fileId: string;
  /** Cannot download the file; for logs only. */
  fileUniqueId: string;
  durationSec: number;
  sizeBytes?: number;
  mimeType?: string;
  status: "pending" | "transcribed" | "failed";
};

/** A voice message is stored without audio: only its Telegram file and the transcript. */
export const messages = chat.table(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    /**
     * Not Telegram's `message_id`: after a crash a queued message is processed after a newer
     * one and would land in the middle of its own history. Not `created_at`: it is the same for
     * all messages of one transaction.
     */
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    uiMessage: jsonb("ui_message").$type<UIMessage>().notNull(),
    voice: jsonb("voice").$type<Voice>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("messages_conversation_seq_idx").on(table.conversationId, table.seq),
  ],
);

/** No index besides the primary key: the owner's turns are few. */
export const turns = chat.table("turns", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id),
  status: text("status")
    .$type<"processing" | "awaiting_login" | "done" | "failed">()
    .notNull(),
  /** No database default: tests control the application clock with fake timers. */
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
  error: text("error"),
  reportedAt: timestamp("reported_at", { withTimezone: true }),
});
