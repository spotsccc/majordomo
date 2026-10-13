import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  numeric,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const finance = pgSchema("finance");

export const currencies = finance.table(
  "currencies",
  {
    code: text("code").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind").$type<"fiat" | "crypto">().notNull(),
    scale: smallint("scale").notNull(),
    rateSource: text("rate_source").$type<"coin" | "fiat">(),
    /** The ticker is no key: dozens of CoinGecko coins share the symbol USDT. */
    rateId: text("rate_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("currencies_code_check", sql`${table.code} ~ '^[A-Z][A-Z0-9]{1,9}$'`),
    check("currencies_kind_check", sql`${table.kind} in ('fiat', 'crypto')`),
    check("currencies_scale_check", sql`${table.scale} between 0 and 18`),
    check(
      "currencies_rate_source_check",
      sql`${table.rateSource} in ('coin', 'fiat')`,
    ),
    check(
      "currencies_rate_id_check",
      sql`(${table.rateSource} is not distinct from 'coin') = (${table.rateId} is not null)`,
    ),
  ],
);

export const rates = finance.table(
  "rates",
  {
    currency: text("currency")
      .notNull()
      .references(() => currencies.code),
    date: date("date").notNull(),
    usdPerUnit: numeric("usd_per_unit", { precision: 38, scale: 18 }).notNull(),
    source: text("source").$type<"coingecko">().notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.currency, table.date] })],
);

export const wallets = finance.table(
  "wallets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    note: text("note"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("wallets_active_name_uq")
      .on(sql`lower(${table.name})`)
      .where(sql`${table.archivedAt} is null`),
  ],
);

export const balances = finance.table(
  "balances",
  {
    walletId: uuid("wallet_id").notNull(),
    currency: text("currency").notNull(),
    /** Changed only in SQL (`amount + delta`): JavaScript numbers lose digits of an 18-place amount. */
    amount: numeric("amount", { precision: 38, scale: 18 })
      .notNull()
      .default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.walletId, table.currency] }),
    foreignKey({
      name: "balances_wallet_fk",
      columns: [table.walletId],
      foreignColumns: [wallets.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "balances_currency_fk",
      columns: [table.currency],
      foreignColumns: [currencies.code],
    }).onDelete("restrict"),
    check("balances_amount_check", sql`${table.amount} >= 0`),
  ],
);

export const categories = finance.table(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("categories_active_name_uq")
      .on(sql`lower(${table.name})`)
      .where(sql`${table.archivedAt} is null`),
  ],
);

export const transactions = finance.table(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Plain text rather than a Postgres enum: a new type then needs no `ALTER TYPE`. */
    type: text("type")
      .$type<"income" | "expense" | "transfer" | "adjustment">()
      .notNull(),
    fromWalletId: uuid("from_wallet_id"),
    fromCurrency: text("from_currency"),
    fromAmount: numeric("from_amount", { precision: 38, scale: 18 }),
    toWalletId: uuid("to_wallet_id"),
    toCurrency: text("to_currency"),
    toAmount: numeric("to_amount", { precision: 38, scale: 18 }),
    feeCurrency: text("fee_currency"),
    feeAmount: numeric("fee_amount", { precision: 38, scale: 18 }),
    categoryId: uuid("category_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    note: text("note"),
    /** No database default: tests control the application clock with fake timers. */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      name: "transactions_from_balance_fk",
      columns: [table.fromWalletId, table.fromCurrency],
      foreignColumns: [balances.walletId, balances.currency],
    }).onDelete("restrict"),
    foreignKey({
      name: "transactions_to_balance_fk",
      columns: [table.toWalletId, table.toCurrency],
      foreignColumns: [balances.walletId, balances.currency],
    }).onDelete("restrict"),
    foreignKey({
      name: "transactions_fee_balance_fk",
      columns: [table.fromWalletId, table.feeCurrency],
      foreignColumns: [balances.walletId, balances.currency],
    }).onDelete("restrict"),
    foreignKey({
      name: "transactions_category_fk",
      columns: [table.categoryId],
      foreignColumns: [categories.id],
    }).onDelete("restrict"),
    check(
      "transactions_type_check",
      sql`${table.type} in ('income', 'expense', 'transfer', 'adjustment')`,
    ),
    check(
      "transactions_sides_check",
      sql`num_nulls(${table.fromWalletId}, ${table.fromCurrency}, ${table.fromAmount}) in (0, 3)
        and num_nulls(${table.toWalletId}, ${table.toCurrency}, ${table.toAmount}) in (0, 3)
        and case ${table.type}
          when 'income' then ${table.fromWalletId} is null and ${table.toWalletId} is not null
          when 'expense' then ${table.fromWalletId} is not null and ${table.toWalletId} is null
          when 'transfer' then ${table.fromWalletId} is not null and ${table.toWalletId} is not null
          when 'adjustment' then (${table.fromWalletId} is null) <> (${table.toWalletId} is null) and ${table.feeAmount} is null
          else false
        end`,
    ),
    check(
      "transactions_same_balance_check",
      sql`not (${table.fromWalletId} = ${table.toWalletId} and ${table.fromCurrency} = ${table.toCurrency})`,
    ),
    check(
      "transactions_same_currency_amount_check",
      sql`${table.fromCurrency} <> ${table.toCurrency} or ${table.fromAmount} = ${table.toAmount}`,
    ),
    check(
      "transactions_fee_check",
      sql`(${table.feeCurrency} is null) = (${table.feeAmount} is null)
        and (${table.feeCurrency} is null or ${table.fromWalletId} is not null)`,
    ),
    check(
      "transactions_category_check",
      sql`(${table.categoryId} is not null) = (${table.type} = 'expense')`,
    ),
    check(
      "transactions_amounts_check",
      sql`${table.fromAmount} > 0 and ${table.toAmount} > 0 and ${table.feeAmount} > 0`,
    ),
    /** `nullsFirst` matches a plain `order by … desc`; with drizzle-kit's default `nulls last` the planner cannot use the index for it. */
    index("transactions_occurred_at_id_idx").on(
      table.occurredAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
  ],
);
