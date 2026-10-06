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

/** Conversations with the owner through messaging channels and their history. */
export const chat = pgSchema("chat");

/**
 * A conversation in one chat of a channel. A chat has at most one open
 * conversation (`closed_at` is null); `/new` closes it by setting `closed_at`,
 * and the next message opens a new one. Closed conversations are kept.
 */
export const conversations = chat.table(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Plain text rather than a Postgres enum: a new channel then needs no `ALTER TYPE`. */
    channel: text("channel").$type<"telegram">().notNull(),
    /** The chat's id in the channel: `thread.id` from Chat SDK for Telegram. */
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
  /** Telegram `file_id`: downloads the audio again, including after a crash. */
  fileId: string;
  /** Telegram `file_unique_id`: for logs, it cannot download the file. */
  fileUniqueId: string;
  durationSec: number;
  /** Optional in the Bot API, like `mimeType`. */
  sizeBytes?: number;
  mimeType?: string;
  status: "pending" | "transcribed" | "failed";
};

/**
 * The history of a conversation: messages of the owner and answers of the
 * agent. A voice message is stored without audio: only its Telegram file and,
 * once recognized, the transcript as a text part of `ui_message`.
 */
export const messages = chat.table(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    /**
     * Order of the history: Postgres numbers rows as they are inserted, so
     * the order is the processing order, with gaps within a conversation
     * because the sequence is shared by all of them. Not Telegram's
     * `message_id`: after a crash a message stuck in the queue is processed
     * after a newer one, and ordering by `message_id` would put the answered
     * message in the middle of its own history. Not `created_at` either: it
     * is the same for all messages written in one transaction.
     */
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    uiMessage: jsonb("ui_message").$type<UIMessage>().notNull(),
    /** Set only for a voice message of the owner. */
    voice: jsonb("voice").$type<Voice>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("messages_conversation_seq_idx").on(table.conversationId, table.seq),
  ],
);

/**
 * One run of the agent over new messages of the owner. Makes failures visible:
 * a turn still `processing` after `deadline_at` is lost (the function died
 * mid-turn), and `awaiting_login` waits for the owner to log in to ChatGPT
 * before it runs again.
 *
 * No index besides the primary key: the owner's turns are few, and lookups by
 * conversation or by status scan the table fast enough.
 */
export const turns = chat.table("turns", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id),
  status: text("status")
    .$type<"processing" | "awaiting_login" | "done" | "failed">()
    .notNull(),
  /**
   * Set by the application together with `deadline_at`, without a database
   * default: both come from the same clock, which tests control with fake timers.
   */
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  /** When the turn must have ended; a `processing` turn past it is lost. */
  deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
  /** Why the turn failed, for diagnosis; the owner never sees it. */
  error: text("error"),
  /** When the owner was told the turn was lost, so that it is reported once. */
  reportedAt: timestamp("reported_at", { withTimezone: true }),
});
