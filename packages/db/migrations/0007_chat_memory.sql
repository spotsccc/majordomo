ALTER TABLE "chat"."conversations" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "chat"."conversations" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "chat"."conversations" ADD COLUMN "summary_through_seq" bigint;--> statement-breakpoint
ALTER TABLE "chat"."conversations" ADD COLUMN "summary_search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('russian', lower("title" COLLATE "und-x-icu")), 'A') || setweight(to_tsvector('russian', lower("summary" COLLATE "und-x-icu")), 'B')) STORED;--> statement-breakpoint
ALTER TABLE "chat"."messages" ADD COLUMN "search" "tsvector" GENERATED ALWAYS AS (jsonb_to_tsvector('russian', lower(jsonb_path_query_array("ui_message", '$.parts[*] ? (@.type == "text").text')::text COLLATE "und-x-icu")::jsonb, '["string"]')) STORED NOT NULL;--> statement-breakpoint
CREATE INDEX "conversations_summary_search_idx" ON "chat"."conversations" USING gin ("summary_search");--> statement-breakpoint
CREATE INDEX "messages_search_idx" ON "chat"."messages" USING gin ("search");