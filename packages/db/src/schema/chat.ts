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
import { tsvector } from "./tsvector.ts";

export const chat = pgSchema("chat");

/**
 * Case is folded with `lower(… COLLATE "und-x-icu")` in the search vectors, as in
 * `memory.entries`: in a database with the C locale plain `lower()` leaves Cyrillic letters as
 * they are.
 */
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
    title: text("title"),
    summary: text("summary"),
    summaryThroughSeq: bigint("summary_through_seq", { mode: "number" }),
    summarySearch: tsvector("summary_search").generatedAlwaysAs(
      sql`setweight(to_tsvector('russian', lower("title" COLLATE "und-x-icu")), 'A') || setweight(to_tsvector('russian', lower("summary" COLLATE "und-x-icu")), 'B')`,
    ),
  },
  (table) => [
    uniqueIndex("conversations_open_uq")
      .on(table.channel, table.externalId)
      .where(sql`${table.closedAt} is null`),
    index("conversations_summary_search_idx").using("gin", table.summarySearch),
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
    /**
     * Only the text parts, so tool calls stay out of the search. Not `to_tsvector(…::text)`: the
     * JSON escapes would stay, and "привет\n\nмир" would give the lexeme "nмир".
     */
    search: tsvector("search")
      .notNull()
      .generatedAlwaysAs(
        sql`jsonb_to_tsvector('russian', lower(jsonb_path_query_array("ui_message", '$.parts[*] ? (@.type == "text").text')::text COLLATE "und-x-icu")::jsonb, '["string"]')`,
      ),
  },
  (table) => [
    index("messages_conversation_seq_idx").on(table.conversationId, table.seq),
    index("messages_search_idx").using("gin", table.search),
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
