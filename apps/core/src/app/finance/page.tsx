import Link from "next/link";
import { requireOwnerSession } from "@/lib/auth";
import {
  listCurrencies,
  listTransactions,
  listWallets,
  summarize,
} from "@/lib/finance/finance-store";
import { netWorth } from "@/lib/finance/rates";
import { ownerIsoDateTime, ownerMonthRange } from "@/lib/owner-time";
import styles from "./finance.module.css";
import { formatDay, money } from "./format";
import { ReadFailed } from "./read-failed";
import { TransactionsTable } from "./transactions-table";

export const metadata = { title: "Финансы — Majordomo" };

const MONTHS = [
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь",
];

export default async function FinancePage({
  searchParams,
}: {
  searchParams: Promise<{ in?: string | string[] }>;
}) {
  await requireOwnerSession();
  const params = await searchParams;
  const currencies = await listCurrencies();
  if (currencies instanceof Error) return <ReadFailed error={currencies} />;
  const inCurrency =
    typeof params.in === "string" &&
    currencies.some((currency) => currency.code === params.in)
      ? params.in
      : "USD";

  // oxlint-disable-next-line react/purity -- a Server Component renders once per request, so the time is fixed for the whole page
  const now = new Date();
  const [wallets, worth, summary, recent] = await Promise.all([
    listWallets(),
    netWorth(inCurrency),
    summarize({ ...ownerMonthRange(now), inCurrency }),
    listTransactions({ limit: 10 }),
  ]);
  if (wallets instanceof Error) return <ReadFailed error={wallets} />;
  if (worth instanceof Error) return <ReadFailed error={worth} />;
  if (summary instanceof Error) return <ReadFailed error={summary} />;
  if (recent instanceof Error) return <ReadFailed error={recent} />;

  const kindOf = (code: string) =>
    currencies.find((currency) => currency.code === code)?.kind ?? "crypto";
  const groups = (["fiat", "crypto"] as const).map((kind) => ({
    kind,
    wallets: wallets.flatMap((wallet) => {
      const balances = wallet.balances.filter(
        (balance) => kindOf(balance.currency) === kind,
      );
      const empty = wallet.balances.length === 0 && kind === "fiat";
      return balances.length > 0 || empty ? [{ ...wallet, balances }] : [];
    }),
  }));
  const largest = new Map<string, number>();
  for (const { currency, amount } of summary.expenses) {
    largest.set(currency, Math.max(largest.get(currency) ?? 0, Number(amount)));
  }
  const month = MONTHS[Number(ownerIsoDateTime(now).slice(5, 7)) - 1];
  const totals = summary.inCurrency;

  return (
    <main className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Финансы</h1>
        <Link href="/finance/transactions/new" className={styles.primary}>
          Новая транзакция
        </Link>
      </div>

      <section className={styles.card} aria-label="Всего">
        <form className={styles.inline} method="get">
          <span className={styles.muted}>Всего в</span>
          <select name="in" defaultValue={inCurrency} aria-label="Валюта итога">
            {currencies.map((currency) => (
              <option key={currency.code} value={currency.code}>
                {currency.code}
              </option>
            ))}
          </select>
          <button className={styles.secondary} type="submit">
            Показать
          </button>
        </form>
        <p className={styles.total}>
          ≈ {money(worth.amount, worth.currency, currencies)}
        </p>
        <p className={styles.muted}>
          {worth.ratesDate
            ? `По курсам на ${formatDay(worth.ratesDate)}`
            : "Курсов пока нет."}
          {worth.missing.length > 0 &&
            ` Без ${worth.missing.join(", ")}: курса нет.`}
        </p>
      </section>

      <div className={styles.grid}>
        {groups.map((group) => (
          <section key={group.kind} className={styles.card}>
            <h2 className={styles.subtitle}>
              {group.kind === "fiat" ? "Фиат" : "Крипта"}
            </h2>
            {group.wallets.length === 0 && (
              <p className={styles.muted}>Кошельков нет.</p>
            )}
            {group.wallets.map((wallet) => (
              <div key={wallet.id} className={styles.row}>
                <Link href={`/finance/wallets/${wallet.id}`}>
                  {wallet.name}
                </Link>
                <span className={styles.amount}>
                  {wallet.balances.length === 0
                    ? "—"
                    : wallet.balances
                        .map((balance) =>
                          money(balance.amount, balance.currency, currencies),
                        )
                        .join(" · ")}
                </span>
              </div>
            ))}
          </section>
        ))}
      </div>

      <section className={styles.card}>
        <h2 className={styles.subtitle}>{month} · траты</h2>
        {totals && (
          <p className={styles.muted}>
            Траты ≈ {money(totals.expenses, totals.currency, currencies)},
            комиссии ≈ {money(totals.fees, totals.currency, currencies)},
            пополнения ≈ {money(totals.income, totals.currency, currencies)}
            {totals.approximate && " (приблизительно)"}
            {totals.missing.length > 0 &&
              `; без ${totals.missing.join(", ")}: курса нет`}
            .
          </p>
        )}
        {summary.expenses.length === 0 && (
          <p className={styles.muted}>Трат в этом месяце нет.</p>
        )}
        {summary.expenses.map((expense) => (
          <div key={`${expense.categoryId} ${expense.currency}`}>
            <div className={styles.row}>
              <span>{expense.categoryName}</span>
              <span className={styles.amount}>
                {money(expense.amount, expense.currency, currencies)}
              </span>
            </div>
            <div
              className={styles.bar}
              style={{
                width: `${(Number(expense.amount) / (largest.get(expense.currency) ?? 1)) * 100}%`,
              }}
            />
          </div>
        ))}
        {summary.fees.map((fee) => (
          <div key={fee.currency} className={styles.row}>
            <span>Комиссии</span>
            <span className={styles.amount}>
              {money(fee.amount, fee.currency, currencies)}
            </span>
          </div>
        ))}
      </section>

      <section className={styles.card}>
        <div className={styles.header}>
          <h2 className={styles.subtitle}>Последние транзакции</h2>
          <Link href="/finance/transactions">Все транзакции</Link>
        </div>
        <TransactionsTable
          transactions={recent.transactions}
          currencies={currencies}
        />
      </section>

      <p className={styles.footer}>
        Data provided by{" "}
        <a href="https://www.coingecko.com" rel="noreferrer">
          CoinGecko
        </a>
      </p>
    </main>
  );
}
