import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { conversations, messages } from "./chat.ts";

export const memory = pgSchema("memory");

const tsvector = customType<{ data: string }>({
  dataType: () => "tsvector",
});

export type EntryKind = "person" | "preference" | "fact" | "plan";

export type CoreSection = "instructions" | "profile";

/**
 * Case is folded with `lower(… COLLATE "und-x-icu")` in the search vector and in the title
 * index: in a database with the C locale plain `lower()` leaves Cyrillic letters as they are.
 */
export const entries = memory.table(
  "entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Plain text with a CHECK rather than an enum: a new kind then needs no `ALTER TYPE`. */
    kind: text("kind").$type<EntryKind>().notNull(),
    title: text("title").notNull(),
    text: text("text").notNull(),
    source: text("source").$type<"owner" | "inferred">().notNull(),
    sourceMessageId: uuid("source_message_id")
      .notNull()
      .references(() => messages.id),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    status: text("status")
      .$type<"active" | "archived">()
      .notNull()
      .default("active"),
    supersededBy: uuid("superseded_by").references(
      (): AnyPgColumn => entries.id,
    ),
    version: integer("version").notNull().default(1),
    useCount: integer("use_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    search: tsvector("search")
      .notNull()
      .generatedAlwaysAs(
        sql`setweight(to_tsvector('russian', lower("title" COLLATE "und-x-icu")), 'A') || setweight(to_tsvector('russian', lower("text" COLLATE "und-x-icu")), 'B')`,
      ),
  },
  (table) => [
    check(
      "entries_kind_check",
      sql`${table.kind} in ('person', 'preference', 'fact', 'plan')`,
    ),
    check(
      "entries_source_check",
      sql`${table.source} in ('owner', 'inferred')`,
    ),
    check(
      "entries_status_check",
      sql`${table.status} in ('active', 'archived')`,
    ),
    check(
      "entries_length_check",
      sql`char_length(${table.title}) <= 60 and char_length(${table.text}) <= 300`,
    ),
    check(
      "entries_plan_valid_until_check",
      sql`${table.kind} <> 'plan' or ${table.validUntil} is not null`,
    ),
    uniqueIndex("entries_active_title_uq")
      .on(sql`lower(${table.title} COLLATE "und-x-icu")`)
      .where(sql`${table.status} = 'active'`),
    index("entries_search_idx").using("gin", table.search),
  ],
);

/** The core is small, so it has no index besides the primary key. */
export const core = memory.table(
  "core",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    section: text("section").$type<CoreSection>().notNull(),
    text: text("text").notNull(),
    source: text("source").$type<"owner" | "inferred">().notNull(),
    sourceMessageId: uuid("source_message_id")
      .notNull()
      .references(() => messages.id),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    status: text("status")
      .$type<"active" | "archived">()
      .notNull()
      .default("active"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "core_section_check",
      sql`${table.section} in ('instructions', 'profile')`,
    ),
    check("core_source_check", sql`${table.source} in ('owner', 'inferred')`),
    check("core_status_check", sql`${table.status} in ('active', 'archived')`),
    check("core_length_check", sql`char_length(${table.text}) <= 300`),
  ],
);

export const changes = memory.table(
  "changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entryId: uuid("entry_id").references(() => entries.id),
    coreId: integer("core_id").references(() => core.id),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actor: text("actor")
      .$type<"agent" | "extractor" | "consolidator">()
      .notNull(),
    action: text("action")
      .$type<"create" | "update" | "archive" | "restore" | "merge" | "move">()
      .notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    conversationId: uuid("conversation_id").references(() => conversations.id),
    reason: text("reason"),
    reportedAt: timestamp("reported_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "changes_target_check",
      sql`num_nonnulls(${table.entryId}, ${table.coreId}) = 1`,
    ),
    check(
      "changes_actor_check",
      sql`${table.actor} in ('agent', 'extractor', 'consolidator')`,
    ),
    check(
      "changes_action_check",
      sql`${table.action} in ('create', 'update', 'archive', 'restore', 'merge', 'move')`,
    ),
    index("changes_unreported_at_idx")
      .on(table.at)
      .where(sql`${table.reportedAt} is null`),
  ],
);
