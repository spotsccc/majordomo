CREATE SCHEMA "finance";
--> statement-breakpoint
CREATE TABLE "finance"."balances" (
	"wallet_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"amount" numeric(38, 18) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "balances_wallet_id_currency_pk" PRIMARY KEY("wallet_id","currency"),
	CONSTRAINT "balances_amount_check" CHECK ("finance"."balances"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "finance"."categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance"."currencies" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"scale" smallint NOT NULL,
	"rate_source" text,
	"rate_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "currencies_code_check" CHECK ("finance"."currencies"."code" ~ '^[A-Z][A-Z0-9]{1,9}$'),
	CONSTRAINT "currencies_kind_check" CHECK ("finance"."currencies"."kind" in ('fiat', 'crypto')),
	CONSTRAINT "currencies_scale_check" CHECK ("finance"."currencies"."scale" between 0 and 18),
	CONSTRAINT "currencies_rate_source_check" CHECK ("finance"."currencies"."rate_source" in ('coin', 'fiat')),
	CONSTRAINT "currencies_rate_id_check" CHECK (("finance"."currencies"."rate_source" is not distinct from 'coin') = ("finance"."currencies"."rate_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "finance"."rates" (
	"currency" text NOT NULL,
	"date" date NOT NULL,
	"usd_per_unit" numeric(38, 18) NOT NULL,
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rates_currency_date_pk" PRIMARY KEY("currency","date")
);
--> statement-breakpoint
CREATE TABLE "finance"."transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"from_wallet_id" uuid,
	"from_currency" text,
	"from_amount" numeric(38, 18),
	"to_wallet_id" uuid,
	"to_currency" text,
	"to_amount" numeric(38, 18),
	"fee_currency" text,
	"fee_amount" numeric(38, 18),
	"category_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "transactions_type_check" CHECK ("finance"."transactions"."type" in ('income', 'expense', 'transfer', 'adjustment')),
	CONSTRAINT "transactions_sides_check" CHECK (num_nulls("finance"."transactions"."from_wallet_id", "finance"."transactions"."from_currency", "finance"."transactions"."from_amount") in (0, 3)
        and num_nulls("finance"."transactions"."to_wallet_id", "finance"."transactions"."to_currency", "finance"."transactions"."to_amount") in (0, 3)
        and case "finance"."transactions"."type"
          when 'income' then "finance"."transactions"."from_wallet_id" is null and "finance"."transactions"."to_wallet_id" is not null
          when 'expense' then "finance"."transactions"."from_wallet_id" is not null and "finance"."transactions"."to_wallet_id" is null
          when 'transfer' then "finance"."transactions"."from_wallet_id" is not null and "finance"."transactions"."to_wallet_id" is not null
          when 'adjustment' then ("finance"."transactions"."from_wallet_id" is null) <> ("finance"."transactions"."to_wallet_id" is null) and "finance"."transactions"."fee_amount" is null
          else false
        end),
	CONSTRAINT "transactions_same_balance_check" CHECK (not ("finance"."transactions"."from_wallet_id" = "finance"."transactions"."to_wallet_id" and "finance"."transactions"."from_currency" = "finance"."transactions"."to_currency")),
	CONSTRAINT "transactions_same_currency_amount_check" CHECK ("finance"."transactions"."from_currency" <> "finance"."transactions"."to_currency" or "finance"."transactions"."from_amount" = "finance"."transactions"."to_amount"),
	CONSTRAINT "transactions_fee_check" CHECK (("finance"."transactions"."fee_currency" is null) = ("finance"."transactions"."fee_amount" is null)
        and ("finance"."transactions"."fee_currency" is null or "finance"."transactions"."from_wallet_id" is not null)),
	CONSTRAINT "transactions_category_check" CHECK (("finance"."transactions"."category_id" is not null) = ("finance"."transactions"."type" = 'expense')),
	CONSTRAINT "transactions_amounts_check" CHECK ("finance"."transactions"."from_amount" > 0 and "finance"."transactions"."to_amount" > 0 and "finance"."transactions"."fee_amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "finance"."wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"note" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finance"."balances" ADD CONSTRAINT "balances_wallet_fk" FOREIGN KEY ("wallet_id") REFERENCES "finance"."wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."balances" ADD CONSTRAINT "balances_currency_fk" FOREIGN KEY ("currency") REFERENCES "finance"."currencies"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."rates" ADD CONSTRAINT "rates_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "finance"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."transactions" ADD CONSTRAINT "transactions_from_balance_fk" FOREIGN KEY ("from_wallet_id","from_currency") REFERENCES "finance"."balances"("wallet_id","currency") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."transactions" ADD CONSTRAINT "transactions_to_balance_fk" FOREIGN KEY ("to_wallet_id","to_currency") REFERENCES "finance"."balances"("wallet_id","currency") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."transactions" ADD CONSTRAINT "transactions_fee_balance_fk" FOREIGN KEY ("from_wallet_id","fee_currency") REFERENCES "finance"."balances"("wallet_id","currency") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."transactions" ADD CONSTRAINT "transactions_category_fk" FOREIGN KEY ("category_id") REFERENCES "finance"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_active_name_uq" ON "finance"."categories" USING btree (lower("name")) WHERE "finance"."categories"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "transactions_occurred_at_id_idx" ON "finance"."transactions" USING btree ("occurred_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_active_name_uq" ON "finance"."wallets" USING btree (lower("name")) WHERE "finance"."wallets"."archived_at" is null;