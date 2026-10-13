import {
  balances,
  categories,
  currencies,
  transactions,
  wallets,
} from "@repo/db";
import { NotFoundError, ValidationError } from "@repo/errors";
import { createTaggedError } from "@spotsccc/error-as-value";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db } from "../db";
import { convert, scaleOf } from "./rates";
import {
  fractionDigits,
  trimAmount,
  type NewCurrency,
  type TransactionInput,
} from "./money";

export class InsufficientFundsError extends createTaggedError({
  name: "InsufficientFundsError",
  message:
    "Недостаточно средств: в «$wallet» $balance $currency, а нужно $required $currency",
}) {}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type TransactionRow = typeof transactions.$inferSelect;
type Amounts = { currency: string; amount: string };
type SideInput = Amounts & { walletId: string };
type Sides = { from?: SideInput; to?: SideInput; fee?: Amounts };
type Term = SideInput & { sign: 1 | -1 };

export type Balance = SideInput;

export type Wallet = typeof wallets.$inferSelect & { balances: Amounts[] };

export type Transaction = {
  id: string;
  type: TransactionRow["type"];
  from: (SideInput & { walletName: string }) | null;
  to: (SideInput & { walletName: string }) | null;
  fee: Amounts | null;
  category: { id: string; name: string } | null;
  occurredAt: Date;
  deletedAt: Date | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type Written = { transaction: Transaction; balances: Balance[] };

export async function listWallets({
  includeArchived = false,
}: { includeArchived?: boolean } = {}): Promise<Error | Wallet[]> {
  const rows = await db
    .select({
      wallet: wallets,
      currency: balances.currency,
      amount: balances.amount,
    })
    .from(wallets)
    .leftJoin(balances, eq(balances.walletId, wallets.id))
    .where(includeArchived ? undefined : isNull(wallets.archivedAt))
    .orderBy(asc(wallets.createdAt), asc(wallets.id), asc(balances.currency))
    .catch(
      (cause: unknown) => new Error("Не удалось прочитать кошельки", { cause }),
    );
  if (rows instanceof Error) return rows;

  const byId = new Map<string, Wallet>();
  for (const { wallet, currency, amount } of rows) {
    const entry = byId.get(wallet.id) ?? { ...wallet, balances: [] };
    if (currency !== null && amount !== null) {
      entry.balances.push({ currency, amount: trimAmount(amount) });
    }
    byId.set(wallet.id, entry);
  }
  return [...byId.values()];
}

export async function createWallet({
  name,
  note,
  currencies: codes = [],
}: {
  name: string;
  note?: string;
  currencies?: string[];
}): Promise<Error | Wallet> {
  const cleanName = name.trim();
  if (!cleanName)
    return new ValidationError({ message: "Пустое имя кошелька" });

  return db
    .transaction(async (tx) => {
      const [wallet] = await tx
        .insert(wallets)
        .values({ name: cleanName, note: note?.trim() || null })
        .onConflictDoNothing()
        .returning();
      if (!wallet) {
        throw new ValidationError({
          message: `Кошелёк «${cleanName}» уже есть`,
        });
      }
      const unknown = await unknownCurrencies(tx, codes);
      if (unknown) throw unknown;
      const unique = [...new Set(codes)].sort();
      if (unique.length > 0) {
        await tx
          .insert(balances)
          .values(
            unique.map((currency) => ({ walletId: wallet.id, currency })),
          );
      }
      return {
        ...wallet,
        balances: unique.map((currency) => ({ currency, amount: "0" })),
      };
    })
    .catch(keepDomainError("Не удалось создать кошелёк"));
}

export async function updateWallet(
  id: string,
  changes: { name?: string; note?: string | null },
): Promise<Error | typeof wallets.$inferSelect> {
  const name = changes.name?.trim();
  if (name === "")
    return new ValidationError({ message: "Пустое имя кошелька" });

  const rows = await db
    .update(wallets)
    .set({
      name,
      note:
        changes.note === undefined ? undefined : changes.note?.trim() || null,
    })
    .where(eq(wallets.id, id))
    .returning()
    .catch((cause: unknown) =>
      isUniqueViolation(cause)
        ? new ValidationError({ message: `Кошелёк «${name}» уже есть` })
        : new Error("Не удалось изменить кошелёк", { cause }),
    );
  if (rows instanceof Error) return rows;
  return rows[0] ?? new NotFoundError({ entity: "кошелёк", id });
}

export async function archiveWallet(
  id: string,
): Promise<Error | typeof wallets.$inferSelect> {
  const rows = await db
    .update(wallets)
    .set({ archivedAt: sql`coalesce(${wallets.archivedAt}, ${new Date()})` })
    .where(eq(wallets.id, id))
    .returning()
    .catch(
      (cause: unknown) =>
        new Error("Не удалось убрать кошелёк в архив", { cause }),
    );
  if (rows instanceof Error) return rows;
  return rows[0] ?? new NotFoundError({ entity: "кошелёк", id });
}

/** Deleted transactions count too: they still reference the wallet's balances and can be restored. */
export async function deleteWallet(id: string): Promise<Error | undefined> {
  return db
    .transaction(async (tx) => {
      const [wallet] = await tx
        .select({ name: wallets.name })
        .from(wallets)
        .where(eq(wallets.id, id))
        .for("update");
      if (!wallet) throw new NotFoundError({ entity: "кошелёк", id });
      const [used] = await tx
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          sql`${transactions.fromWalletId} = ${id} or ${transactions.toWalletId} = ${id}`,
        )
        .limit(1);
      if (used) {
        throw new ValidationError({
          message: `У кошелька «${wallet.name}» есть транзакции: его можно только убрать в архив`,
        });
      }
      await tx.delete(balances).where(eq(balances.walletId, id));
      await tx.delete(wallets).where(eq(wallets.id, id));
      return undefined;
    })
    .catch(keepDomainError("Не удалось удалить кошелёк"));
}

export async function addWalletCurrency(
  walletId: string,
  currency: string,
): Promise<Error | Balance> {
  return db
    .transaction(async (tx) => {
      const [wallet] = await tx
        .select({ id: wallets.id })
        .from(wallets)
        .where(eq(wallets.id, walletId));
      if (!wallet) throw new NotFoundError({ entity: "кошелёк", id: walletId });
      const unknown = await unknownCurrencies(tx, [currency]);
      if (unknown) throw unknown;
      await tx
        .insert(balances)
        .values({ walletId, currency })
        .onConflictDoNothing();
      const [balance] = await tx
        .select({ amount: balances.amount })
        .from(balances)
        .where(
          and(eq(balances.walletId, walletId), eq(balances.currency, currency)),
        );
      return { walletId, currency, amount: trimAmount(balance?.amount ?? "0") };
    })
    .catch(keepDomainError("Не удалось добавить валюту в кошелёк"));
}

export async function listCategories({
  includeArchived = false,
}: { includeArchived?: boolean } = {}): Promise<
  Error | (typeof categories.$inferSelect)[]
> {
  return db
    .select()
    .from(categories)
    .where(includeArchived ? undefined : isNull(categories.archivedAt))
    .orderBy(asc(categories.name))
    .catch(
      (cause: unknown) =>
        new Error("Не удалось прочитать категории", { cause }),
    );
}

export async function createCategory(
  name: string,
): Promise<Error | typeof categories.$inferSelect> {
  const cleanName = name.trim();
  if (!cleanName)
    return new ValidationError({ message: "Пустое имя категории" });

  const rows = await db
    .insert(categories)
    .values({ name: cleanName })
    .onConflictDoNothing()
    .returning()
    .catch(
      (cause: unknown) => new Error("Не удалось создать категорию", { cause }),
    );
  if (rows instanceof Error) return rows;
  return (
    rows[0] ??
    new ValidationError({ message: `Категория «${cleanName}» уже есть` })
  );
}

export async function renameCategory(
  id: string,
  name: string,
): Promise<Error | typeof categories.$inferSelect> {
  const cleanName = name.trim();
  if (!cleanName)
    return new ValidationError({ message: "Пустое имя категории" });

  const rows = await db
    .update(categories)
    .set({ name: cleanName })
    .where(eq(categories.id, id))
    .returning()
    .catch((cause: unknown) =>
      isUniqueViolation(cause)
        ? new ValidationError({ message: `Категория «${cleanName}» уже есть` })
        : new Error("Не удалось переименовать категорию", { cause }),
    );
  if (rows instanceof Error) return rows;
  return rows[0] ?? new NotFoundError({ entity: "категория", id });
}

export async function archiveCategory(
  id: string,
): Promise<Error | typeof categories.$inferSelect> {
  const rows = await db
    .update(categories)
    .set({
      archivedAt: sql`coalesce(${categories.archivedAt}, ${new Date()})`,
    })
    .where(eq(categories.id, id))
    .returning()
    .catch(
      (cause: unknown) =>
        new Error("Не удалось убрать категорию в архив", { cause }),
    );
  if (rows instanceof Error) return rows;
  return rows[0] ?? new NotFoundError({ entity: "категория", id });
}

export async function listCurrencies(): Promise<
  Error | (typeof currencies.$inferSelect)[]
> {
  return db
    .select()
    .from(currencies)
    .orderBy(asc(currencies.kind), asc(currencies.code))
    .catch(
      (cause: unknown) => new Error("Не удалось прочитать валюты", { cause }),
    );
}

export async function addCurrency(
  currency: NewCurrency,
): Promise<Error | typeof currencies.$inferSelect> {
  const rows = await db
    .insert(currencies)
    .values({
      code: currency.code,
      name: currency.name,
      kind: currency.kind,
      scale: currency.scale,
      rateSource: currency.kind === "fiat" ? "fiat" : "coin",
      rateId: currency.rateId ?? null,
    })
    .onConflictDoNothing()
    .returning()
    .catch(
      (cause: unknown) => new Error("Не удалось добавить валюту", { cause }),
    );
  if (rows instanceof Error) return rows;
  return (
    rows[0] ??
    new ValidationError({ message: `Валюта ${currency.code} уже есть` })
  );
}

export async function listTransactions(filter: {
  walletId?: string;
  type?: TransactionRow["type"];
  currency?: string;
  categoryId?: string;
  from?: Date;
  to?: Date;
  search?: string;
  deleted?: boolean;
  limit: number;
  cursor?: string;
}): Promise<
  Error | { transactions: Transaction[]; nextCursor: string | null }
> {
  const conditions: SQL[] = [
    filter.deleted
      ? isNotNull(transactions.deletedAt)
      : isNull(transactions.deletedAt),
  ];
  if (filter.walletId) {
    conditions.push(
      sql`(${transactions.fromWalletId} = ${filter.walletId} or ${transactions.toWalletId} = ${filter.walletId})`,
    );
  }
  if (filter.type) conditions.push(eq(transactions.type, filter.type));
  if (filter.currency) {
    conditions.push(
      sql`${filter.currency} in (${transactions.fromCurrency}, ${transactions.toCurrency}, ${transactions.feeCurrency})`,
    );
  }
  if (filter.categoryId) {
    conditions.push(eq(transactions.categoryId, filter.categoryId));
  }
  if (filter.from) conditions.push(gte(transactions.occurredAt, filter.from));
  if (filter.to) conditions.push(lt(transactions.occurredAt, filter.to));
  if (filter.search) {
    conditions.push(ilike(transactions.note, `%${filter.search}%`));
  }
  if (filter.cursor) {
    const cursor = parseCursor(filter.cursor);
    if (cursor instanceof Error) return cursor;
    conditions.push(
      sql`(${transactions.occurredAt}, ${transactions.id}) < (${cursor.occurredAt}::timestamptz, ${cursor.id}::uuid)`,
    );
  }

  const rows = await selectTransactions()
    .where(and(...conditions))
    .orderBy(desc(transactions.occurredAt), desc(transactions.id))
    .limit(filter.limit + 1)
    .catch(
      (cause: unknown) =>
        new Error("Не удалось прочитать транзакции", { cause }),
    );
  if (rows instanceof Error) return rows;

  const page = rows.slice(0, filter.limit).map(toTransaction);
  const last = page.at(-1);
  return {
    transactions: page,
    nextCursor:
      rows.length > filter.limit && last
        ? `${last.occurredAt.toISOString()}_${last.id}`
        : null,
  };
}

export async function getTransaction(id: string): Promise<Error | Transaction> {
  const rows = await selectTransactions()
    .where(eq(transactions.id, id))
    .catch(
      (cause: unknown) =>
        new Error("Не удалось прочитать транзакцию", { cause }),
    );
  if (rows instanceof Error) return rows;
  const [row] = rows;
  return row
    ? toTransaction(row)
    : new NotFoundError({ entity: "транзакция", id });
}

export async function createTransaction(
  input: TransactionInput,
): Promise<Error | Written> {
  const now = new Date();
  const written = await db
    .transaction(async (tx) => {
      const invalid = await checkReferences(tx, input);
      if (invalid) throw invalid;
      const changed = await applyEffect(tx, effect(sidesOf(input)), now);
      const [row] = await tx
        .insert(transactions)
        .values({
          ...columnsOf(input, input.occurredAt ?? now),
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: transactions.id });
      if (!row) throw new Error("INSERT транзакции не вернул строку");
      return { id: row.id, balances: changed };
    })
    .catch(keepDomainError("Не удалось записать транзакцию"));
  return withTransaction(written);
}

/** An omitted `occurredAt` keeps the old date: the current time would silently move the transaction. */
export async function updateTransaction(
  id: string,
  input: TransactionInput,
): Promise<Error | Written> {
  const now = new Date();
  const written = await db
    .transaction(async (tx) => {
      const [previous] = await tx
        .select()
        .from(transactions)
        .where(eq(transactions.id, id))
        .for("update");
      if (!previous) throw new NotFoundError({ entity: "транзакция", id });
      if (previous.deletedAt) {
        throw new ValidationError({
          message:
            "Удалённую транзакцию нельзя править: сначала восстановите её",
        });
      }
      const invalid = await checkReferences(tx, input, previous);
      if (invalid) throw invalid;
      const terms = [
        ...negate(effect(sidesOfRow(previous))),
        ...effect(sidesOf(input)),
      ];
      const changed = await applyEffect(tx, terms, now);
      await tx
        .update(transactions)
        .set({
          ...columnsOf(input, input.occurredAt ?? previous.occurredAt),
          updatedAt: now,
        })
        .where(eq(transactions.id, id));
      return { id, balances: changed };
    })
    .catch(keepDomainError("Не удалось изменить транзакцию"));
  return withTransaction(written);
}

/** `deleted_at is null` in the UPDATE makes a concurrent second delete find no row, so the effect is undone once. */
export async function deleteTransaction(id: string): Promise<Error | Written> {
  const now = new Date();
  const written = await db
    .transaction(async (tx) => {
      const [row] = await tx
        .update(transactions)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(transactions.id, id), isNull(transactions.deletedAt)))
        .returning();
      if (!row) throw await notFoundOr(tx, id, "Транзакция уже удалена");
      const changed = await applyEffect(
        tx,
        negate(effect(sidesOfRow(row))),
        now,
      );
      return { id, balances: changed };
    })
    .catch(keepDomainError("Не удалось удалить транзакцию"));
  return withTransaction(written);
}

export async function restoreTransaction(id: string): Promise<Error | Written> {
  const now = new Date();
  const written = await db
    .transaction(async (tx) => {
      const [row] = await tx
        .update(transactions)
        .set({ deletedAt: null, updatedAt: now })
        .where(and(eq(transactions.id, id), isNotNull(transactions.deletedAt)))
        .returning();
      if (!row) throw await notFoundOr(tx, id, "Транзакция не удалена");
      const changed = await applyEffect(tx, effect(sidesOfRow(row)), now);
      return { id, balances: changed };
    })
    .catch(keepDomainError("Не удалось восстановить транзакцию"));
  return withTransaction(written);
}

export type Totals = {
  currency: string;
  income: string;
  expenses: string;
  fees: string;
  approximate: boolean;
  missing: string[];
};

export type Summary = {
  income: Amounts[];
  expenses: (Amounts & { categoryId: string; categoryName: string })[];
  fees: Amounts[];
  inCurrency?: Totals;
};

export async function summarize({
  from,
  to,
  walletId,
  inCurrency,
}: {
  from: Date;
  to: Date;
  walletId?: string;
  inCurrency?: string;
}): Promise<Error | Summary> {
  const period = and(
    isNull(transactions.deletedAt),
    gte(transactions.occurredAt, from),
    lt(transactions.occurredAt, to),
  );
  const fromWallet = walletId
    ? eq(transactions.fromWalletId, walletId)
    : undefined;
  const toWallet = walletId ? eq(transactions.toWalletId, walletId) : undefined;
  const incomes =
    and(period, eq(transactions.type, "income"), toWallet) ?? sql`false`;
  const spent =
    and(period, eq(transactions.type, "expense"), fromWallet) ?? sql`false`;
  const fees =
    and(period, isNotNull(transactions.feeCurrency), fromWallet) ?? sql`false`;

  const summary = await Promise.all([
    db
      .select({
        currency: sql<string>`${transactions.toCurrency}`,
        amount: sql<string>`sum(${transactions.toAmount})::text`,
      })
      .from(transactions)
      .where(incomes)
      .groupBy(transactions.toCurrency)
      .orderBy(asc(transactions.toCurrency)),
    db
      .select({
        categoryId: categories.id,
        categoryName: categories.name,
        currency: sql<string>`${transactions.fromCurrency}`,
        amount: sql<string>`sum(${transactions.fromAmount})::text`,
      })
      .from(transactions)
      .innerJoin(categories, eq(categories.id, transactions.categoryId))
      .where(spent)
      .groupBy(categories.id, categories.name, transactions.fromCurrency)
      .orderBy(asc(categories.name), asc(transactions.fromCurrency)),
    db
      .select({
        currency: sql<string>`${transactions.feeCurrency}`,
        amount: sql<string>`sum(${transactions.feeAmount})::text`,
      })
      .from(transactions)
      .where(fees)
      .groupBy(transactions.feeCurrency)
      .orderBy(asc(transactions.feeCurrency)),
    inCurrency ? totalsIn(inCurrency, { incomes, spent, fees }) : undefined,
  ]).catch(
    (cause: unknown) => new Error("Не удалось посчитать сводку", { cause }),
  );
  if (summary instanceof Error) return summary;

  const [incomeRows, expenseRows, feeRows, totals] = summary;
  if (totals instanceof Error) return totals;
  const trim = <T extends Amounts>(row: T): T => ({
    ...row,
    amount: trimAmount(row.amount),
  });
  return {
    income: incomeRows.map(trim),
    expenses: expenseRows.map(trim),
    fees: feeRows.map(trim),
    ...(totals && { inCurrency: totals }),
  };
}

const TotalsRow = z.object({
  kind: z.enum(["income", "expense", "fee"]),
  amount: z.string(),
  approximate: z.boolean(),
  missing: z.array(z.string()),
});

/** Each amount is converted at the rate of its own UTC day (П16), then summed by Postgres. */
async function totalsIn(
  currency: string,
  filters: { incomes: SQL; spent: SQL; fees: SQL },
): Promise<Error | Totals> {
  const scale = await scaleOf(currency);
  if (scale instanceof Error) return scale;

  const day = sql`(${transactions.occurredAt} at time zone 'UTC')::date`;
  const items = sql`
    select 'income' as kind, ${transactions.toCurrency} as currency, ${transactions.toAmount} as amount, ${day} as day
      from ${transactions} where ${filters.incomes}
    union all
    select 'expense', ${transactions.fromCurrency}, ${transactions.fromAmount}, ${day}
      from ${transactions} where ${filters.spent}
    union all
    select 'fee', ${transactions.feeCurrency}, ${transactions.feeAmount}, ${day}
      from ${transactions} where ${filters.fees}`;
  const { value, approximate } = convert(
    sql`items.amount`,
    sql`items.currency`,
    currency,
    sql`items.day`,
  );
  const result = await db
    .execute(sql`
    select kind,
           round(coalesce(sum(${value}), 0), ${scale})::text as amount,
           coalesce(bool_or(${approximate}), false) as approximate,
           coalesce(array_agg(distinct items.currency) filter (where ${value} is null), '{}') as missing
      from (${items}) items
     group by kind`)
    .catch(
      (cause: unknown) =>
        new Error("Не удалось посчитать сводку в валюте", { cause }),
    );
  if (result instanceof Error) return result;
  const parsed = z.array(TotalsRow).safeParse(result.rows);
  if (!parsed.success) {
    return new Error("Неверные строки сводки в валюте", {
      cause: parsed.error,
    });
  }
  const rows = parsed.data;
  const amountOf = (kind: z.infer<typeof TotalsRow>["kind"]) =>
    trimAmount(rows.find((row) => row.kind === kind)?.amount ?? "0");
  return {
    currency,
    income: amountOf("income"),
    expenses: amountOf("expense"),
    fees: amountOf("fee"),
    approximate: rows.some((row) => row.approximate),
    missing: [...new Set(rows.flatMap((row) => row.missing))].sort(),
  };
}

function keepDomainError(message: string) {
  return (cause: unknown): Error =>
    cause instanceof InsufficientFundsError ||
    cause instanceof ValidationError ||
    cause instanceof NotFoundError
      ? cause
      : new Error(message, { cause });
}

function isUniqueViolation(error: unknown): boolean {
  for (
    let current: unknown = error;
    current instanceof Error;
    current = current.cause
  ) {
    if ("code" in current && current.code === "23505") return true;
  }
  return false;
}

async function unknownCurrencies(
  tx: Tx,
  codes: string[],
): Promise<ValidationError | undefined> {
  if (codes.length === 0) return undefined;
  const known = await tx
    .select({ code: currencies.code })
    .from(currencies)
    .where(inArray(currencies.code, codes));
  const missing = codes.find((code) => !known.some((row) => row.code === code));
  return missing
    ? new ValidationError({ message: `Валюты ${missing} нет в справочнике` })
    : undefined;
}

/** A wallet or category archived after `previous` was written stays usable for editing it. */
async function checkReferences(
  tx: Tx,
  input: TransactionInput,
  previous?: TransactionRow,
): Promise<Error | undefined> {
  const { from, to, fee } = sidesOf(input);

  const walletIds = [
    ...new Set([from?.walletId, to?.walletId].filter((id) => id !== undefined)),
  ];
  const walletRows = await tx
    .select()
    .from(wallets)
    .where(inArray(wallets.id, walletIds));
  for (const id of walletIds) {
    const wallet = walletRows.find((row) => row.id === id);
    if (!wallet) return new NotFoundError({ entity: "кошелёк", id });
    const usedBefore =
      id === previous?.fromWalletId || id === previous?.toWalletId;
    if (wallet.archivedAt && !usedBefore) {
      return new ValidationError({
        message: `Кошелёк «${wallet.name}» в архиве: новые транзакции в нём не записываются`,
      });
    }
  }

  if (input.type === "expense") {
    const [category] = await tx
      .select()
      .from(categories)
      .where(eq(categories.id, input.categoryId));
    if (!category) {
      return new NotFoundError({ entity: "категория", id: input.categoryId });
    }
    if (category.archivedAt && category.id !== previous?.categoryId) {
      return new ValidationError({
        message: `Категория «${category.name}» в архиве`,
      });
    }
  }

  const amounts = [from, to, fee].filter((side) => side !== undefined);
  const known = await tx
    .select({ code: currencies.code, scale: currencies.scale })
    .from(currencies)
    .where(
      inArray(
        currencies.code,
        amounts.map((side) => side.currency),
      ),
    );
  for (const { currency, amount } of amounts) {
    const found = known.find((row) => row.code === currency);
    if (!found) {
      return new ValidationError({
        message: `Валюты ${currency} нет в справочнике`,
      });
    }
    if (fractionDigits(amount) > found.scale) {
      return new ValidationError({
        message: `${amount} ${currency}: у ${currency} не больше ${found.scale} знаков после точки`,
      });
    }
  }
  return undefined;
}

function sidesOf(input: TransactionInput): Sides {
  return {
    from: "from" in input ? input.from : undefined,
    to: "to" in input ? input.to : undefined,
    fee: "fee" in input ? input.fee : undefined,
  };
}

function sidesOfRow(row: TransactionRow): Sides {
  return {
    from:
      row.fromWalletId && row.fromCurrency && row.fromAmount
        ? {
            walletId: row.fromWalletId,
            currency: row.fromCurrency,
            amount: row.fromAmount,
          }
        : undefined,
    to:
      row.toWalletId && row.toCurrency && row.toAmount
        ? {
            walletId: row.toWalletId,
            currency: row.toCurrency,
            amount: row.toAmount,
          }
        : undefined,
    fee:
      row.feeCurrency && row.feeAmount
        ? { currency: row.feeCurrency, amount: row.feeAmount }
        : undefined,
  };
}

function columnsOf(input: TransactionInput, occurredAt: Date) {
  const { from, to, fee } = sidesOf(input);
  return {
    type: input.type,
    fromWalletId: from?.walletId ?? null,
    fromCurrency: from?.currency ?? null,
    fromAmount: from?.amount ?? null,
    toWalletId: to?.walletId ?? null,
    toCurrency: to?.currency ?? null,
    toAmount: to?.amount ?? null,
    feeCurrency: fee?.currency ?? null,
    feeAmount: fee?.amount ?? null,
    categoryId: input.type === "expense" ? input.categoryId : null,
    occurredAt,
    note: input.note ?? null,
  };
}

function effect({ from, to, fee }: Sides): Term[] {
  const terms: Term[] = [];
  if (from) terms.push({ ...from, sign: -1 });
  if (to) terms.push({ ...to, sign: 1 });
  if (from && fee) {
    terms.push({ walletId: from.walletId, ...fee, sign: -1 });
  }
  return terms;
}

function negate(terms: Term[]): Term[] {
  return terms.map((term) => ({ ...term, sign: term.sign === 1 ? -1 : 1 }));
}

/**
 * Balance rows are locked in one order for every caller, so opposite transfers cannot deadlock.
 * Postgres adds the amounts: a JavaScript number would lose digits.
 */
async function applyEffect(
  tx: Tx,
  terms: Term[],
  now: Date,
): Promise<Balance[]> {
  const groups = new Map<
    string,
    { walletId: string; currency: string; terms: Term[] }
  >();
  for (const term of terms) {
    const key = `${term.walletId} ${term.currency}`;
    const group = groups.get(key) ?? {
      walletId: term.walletId,
      currency: term.currency,
      terms: [],
    };
    group.terms.push(term);
    groups.set(key, group);
  }
  const ordered = [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, group]) => group);
  if (ordered.length === 0) return [];

  await tx
    .insert(balances)
    .values(ordered.map(({ walletId, currency }) => ({ walletId, currency })))
    .onConflictDoNothing();

  const changed: Balance[] = [];
  for (const { walletId, currency, terms: group } of ordered) {
    const change = sql`(0 ${sql.join(
      group.map(({ sign, amount }) =>
        sign === 1 ? sql`+ ${amount}::numeric` : sql`- ${amount}::numeric`,
      ),
      sql` `,
    )})`;
    const [row] = await tx
      .update(balances)
      .set({ amount: sql`${balances.amount} + ${change}`, updatedAt: now })
      .where(
        and(
          eq(balances.walletId, walletId),
          eq(balances.currency, currency),
          sql`${balances.amount} + ${change} >= 0`,
        ),
      )
      .returning({ amount: balances.amount });
    if (!row) throw await insufficientFunds(tx, walletId, currency, change);
    changed.push({ walletId, currency, amount: trimAmount(row.amount) });
  }
  return changed;
}

async function insufficientFunds(
  tx: Tx,
  walletId: string,
  currency: string,
  change: SQL,
): Promise<InsufficientFundsError> {
  const [row] = await tx
    .select({
      wallet: wallets.name,
      balance: balances.amount,
      required: sql<string>`(-${change})::text`,
    })
    .from(balances)
    .innerJoin(wallets, eq(wallets.id, balances.walletId))
    .where(
      and(eq(balances.walletId, walletId), eq(balances.currency, currency)),
    );
  return new InsufficientFundsError({
    wallet: row?.wallet ?? walletId,
    currency,
    balance: trimAmount(row?.balance ?? "0"),
    required: trimAmount(row?.required ?? "0"),
  });
}

async function notFoundOr(tx: Tx, id: string, message: string): Promise<Error> {
  const [row] = await tx
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.id, id));
  return row
    ? new ValidationError({ message })
    : new NotFoundError({ entity: "транзакция", id });
}

async function withTransaction(
  written: Error | { id: string; balances: Balance[] },
): Promise<Error | Written> {
  if (written instanceof Error) return written;
  const transaction = await getTransaction(written.id);
  if (transaction instanceof Error) return transaction;
  return { transaction, balances: written.balances };
}

const fromWallets = alias(wallets, "from_wallet");
const toWallets = alias(wallets, "to_wallet");

function selectTransactions() {
  return db
    .select({
      row: transactions,
      fromName: fromWallets.name,
      toName: toWallets.name,
      categoryName: categories.name,
    })
    .from(transactions)
    .leftJoin(fromWallets, eq(fromWallets.id, transactions.fromWalletId))
    .leftJoin(toWallets, eq(toWallets.id, transactions.toWalletId))
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .$dynamic();
}

function toTransaction({
  row,
  fromName,
  toName,
  categoryName,
}: {
  row: TransactionRow;
  fromName: string | null;
  toName: string | null;
  categoryName: string | null;
}): Transaction {
  const { from, to, fee } = sidesOfRow(row);
  return {
    id: row.id,
    type: row.type,
    from: from
      ? { ...from, amount: trimAmount(from.amount), walletName: fromName ?? "" }
      : null,
    to: to
      ? { ...to, amount: trimAmount(to.amount), walletName: toName ?? "" }
      : null,
    fee: fee ? { ...fee, amount: trimAmount(fee.amount) } : null,
    category:
      row.categoryId && categoryName !== null
        ? { id: row.categoryId, name: categoryName }
        : null,
    occurredAt: row.occurredAt,
    deletedAt: row.deletedAt,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseCursor(
  cursor: string,
): ValidationError | { occurredAt: string; id: string } {
  const [occurredAt = "", id = ""] = cursor.split("_");
  const valid =
    z.iso.datetime().safeParse(occurredAt).success &&
    z.uuid().safeParse(id).success;
  return valid
    ? { occurredAt, id }
    : new ValidationError({ message: "Неверный курсор списка транзакций" });
}
