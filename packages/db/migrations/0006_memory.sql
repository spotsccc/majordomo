CREATE SCHEMA "memory";
--> statement-breakpoint
CREATE TABLE "memory"."changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid,
	"core_id" integer,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"conversation_id" uuid,
	"reason" text,
	"reported_at" timestamp with time zone,
	CONSTRAINT "changes_target_check" CHECK (num_nonnulls("memory"."changes"."entry_id", "memory"."changes"."core_id") = 1),
	CONSTRAINT "changes_actor_check" CHECK ("memory"."changes"."actor" in ('agent', 'extractor', 'consolidator')),
	CONSTRAINT "changes_action_check" CHECK ("memory"."changes"."action" in ('create', 'update', 'archive', 'restore', 'merge', 'move'))
);
--> statement-breakpoint
CREATE TABLE "memory"."core" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "memory"."core_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"section" text NOT NULL,
	"text" text NOT NULL,
	"source" text NOT NULL,
	"source_message_id" uuid NOT NULL,
	"valid_until" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_section_check" CHECK ("memory"."core"."section" in ('instructions', 'profile')),
	CONSTRAINT "core_source_check" CHECK ("memory"."core"."source" in ('owner', 'inferred')),
	CONSTRAINT "core_status_check" CHECK ("memory"."core"."status" in ('active', 'archived')),
	CONSTRAINT "core_length_check" CHECK (char_length("memory"."core"."text") <= 300)
);
--> statement-breakpoint
CREATE TABLE "memory"."entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"text" text NOT NULL,
	"source" text NOT NULL,
	"source_message_id" uuid NOT NULL,
	"valid_until" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"superseded_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('russian', lower("title" COLLATE "und-x-icu")), 'A') || setweight(to_tsvector('russian', lower("text" COLLATE "und-x-icu")), 'B')) STORED NOT NULL,
	CONSTRAINT "entries_kind_check" CHECK ("memory"."entries"."kind" in ('person', 'preference', 'fact', 'plan')),
	CONSTRAINT "entries_source_check" CHECK ("memory"."entries"."source" in ('owner', 'inferred')),
	CONSTRAINT "entries_status_check" CHECK ("memory"."entries"."status" in ('active', 'archived')),
	CONSTRAINT "entries_length_check" CHECK (char_length("memory"."entries"."title") <= 60 and char_length("memory"."entries"."text") <= 300),
	CONSTRAINT "entries_plan_valid_until_check" CHECK ("memory"."entries"."kind" <> 'plan' or "memory"."entries"."valid_until" is not null)
);
--> statement-breakpoint
ALTER TABLE "memory"."changes" ADD CONSTRAINT "changes_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "memory"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory"."changes" ADD CONSTRAINT "changes_core_id_core_id_fk" FOREIGN KEY ("core_id") REFERENCES "memory"."core"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory"."changes" ADD CONSTRAINT "changes_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "chat"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory"."core" ADD CONSTRAINT "core_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "chat"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory"."entries" ADD CONSTRAINT "entries_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "chat"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory"."entries" ADD CONSTRAINT "entries_superseded_by_entries_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "memory"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "changes_unreported_at_idx" ON "memory"."changes" USING btree ("at") WHERE "memory"."changes"."reported_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "entries_active_title_uq" ON "memory"."entries" USING btree (lower("title" COLLATE "und-x-icu")) WHERE "memory"."entries"."status" = 'active';--> statement-breakpoint
CREATE INDEX "entries_search_idx" ON "memory"."entries" USING gin ("search");