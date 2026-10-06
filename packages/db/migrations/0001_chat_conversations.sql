CREATE SCHEMA "chat";
--> statement-breakpoint
CREATE TABLE "chat"."conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"external_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_open_uq" ON "chat"."conversations" USING btree ("channel","external_id") WHERE "chat"."conversations"."closed_at" is null;
