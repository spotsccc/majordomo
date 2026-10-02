CREATE SCHEMA "auth";
--> statement-breakpoint
CREATE TABLE "auth"."openai_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"credential" text,
	"refreshed_at" timestamp with time zone,
	"reauth" jsonb,
	"lease_id" text,
	"lease_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."openai_device_logins" (
	"id" text PRIMARY KEY NOT NULL,
	"pending" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
