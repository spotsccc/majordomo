import { ValidationError } from "@repo/errors";
import Link from "next/link";
import { z } from "zod";
import { requireOwnerSession } from "@/lib/auth";
import {
  listCurrencies,
  listTransactions,
  listWallets,
} from "@/lib/finance/finance-store";
import { CurrencyCode } from "@/lib/finance/money";
import { ownerDayRange } from "@/lib/owner-time";
import styles from "../finance.module.css";
import { TYPE_LABELS } from "../format";
import { ReadFailed } from "../read-failed";
import { TransactionsTable } from "../transactions-table";

export const metadata = { title: "Транзакции — Majordomo" };

const Param = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => (Array.isArray(value) ? value[0] : value)?.trim());

/** An invalid filter value is dropped rather than failing the page: the values come from the address bar. */
const Filters = z.object({
  wallet: Param.pipe(z.uuid().optional().catch(undefined)),
  type: Param.pipe(
    z
      .enum(["income", "expense", "transfer", "adjustment"])
      .optional()
      .catch(undefined),
  ),
  currency: Param.pipe(CurrencyCode.optional().catch(undefined)),
  from: Param.pipe(z.iso.date().optional().catch(undefined)),
  to: Param.pipe(z.iso.date().optional().catch(undefined)),
  q: Param.pipe(z.string().min(1).optional().catch(undefined)),
  deleted: Param.pipe(z.literal("1").optional().catch(undefined)),
  cursor: Param,
});

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOwnerSession();
  const filters = Filters.parse(await searchParams);

  const [wallets, currencies, page] = await Promise.all([
    listWallets({ includeArchived: true }),
    listCurrencies(),
    listTransactions({
      walletId: filters.wallet,
      type: filters.type,
      currency: filters.currency,
      from: filters.from ? ownerDayRange(filters.from).from : undefined,
      to: filters.to ? ownerDayRange(filters.to).to : undefined,
      search: filters.q,
      deleted: filters.deleted === "1",
      limit: 50,
      cursor: filters.cursor,
    }),
  ]);
  if (wallets instanceof Error) return <ReadFailed error={wallets} />;
  if (currencies instanceof Error) return <ReadFailed error={currencies} />;
  if (page instanceof Error && !(page instanceof ValidationError)) {
    return <ReadFailed error={page} />;
  }

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (key !== "cursor" && value) query.set(key, value);
  }
  if (!(page instanceof Error) && page.nextCursor) {
    query.set("cursor", page.nextCursor);
  }

  return (
    <main className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Транзакции</h1>
        <Link href="/finance/transactions/new" className={styles.primary}>
          Новая транзакция
        </Link>
      </div>
      <form className={styles.inline} method="get" aria-label="Фильтры">
        <label className={styles.field}>
          Кошелёк
          <select name="wallet" defaultValue={filters.wallet ?? ""}>
            <option value="">все</option>
            {wallets.map((wallet) => (
              <option key={wallet.id} value={wallet.id}>
                {wallet.name}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          Вид
          <select name="type" defaultValue={filters.type ?? ""}>
            <option value="">все</option>
            {Object.entries(TYPE_LABELS).map(([type, label]) => (
              <option key={type} value={type}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          Валюта
          <select name="currency" defaultValue={filters.currency ?? ""}>
            <option value="">все</option>
            {currencies.map((currency) => (
              <option key={currency.code} value={currency.code}>
                {currency.code}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          С
          <input type="date" name="from" defaultValue={filters.from ?? ""} />
        </label>
        <label className={styles.field}>
          По
          <input type="date" name="to" defaultValue={filters.to ?? ""} />
        </label>
        <label className={styles.field}>
          Заметка
          <input name="q" defaultValue={filters.q ?? ""} />
        </label>
        <label>
          <input
            type="checkbox"
            name="deleted"
            value="1"
            defaultChecked={filters.deleted === "1"}
          />{" "}
          Удалённые
        </label>
        <button className={styles.secondary} type="submit">
          Показать
        </button>
      </form>
      {page instanceof Error ? (
        <p className={styles.error}>{page.message}</p>
      ) : (
        <>
          <TransactionsTable
            transactions={page.transactions}
            currencies={currencies}
          />
          {page.nextCursor && (
            <Link href={`/finance/transactions?${query.toString()}`}>Ещё</Link>
          )}
        </>
      )}
    </main>
  );
}
