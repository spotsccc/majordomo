import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireOwnerSession } from "@/lib/auth";
import {
  listCurrencies,
  listTransactions,
  listWallets,
} from "@/lib/finance/finance-store";
import {
  addWalletCurrencyAction,
  archiveWalletAction,
  deleteWalletAction,
  updateWalletAction,
} from "../../actions";
import { ConfirmButton } from "../../confirm-button";
import styles from "../../finance.module.css";
import { formError } from "../../form-errors";
import { money } from "../../format";
import { ReadFailed } from "../../read-failed";
import { TransactionsTable } from "../../transactions-table";

export const metadata = { title: "Кошелёк — Majordomo" };

export default async function WalletPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    error?: string | string[];
    cursor?: string | string[];
  }>;
}) {
  await requireOwnerSession();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const { error, cursor } = await searchParams;

  const [wallets, currencies, page, deleted] = await Promise.all([
    listWallets({ includeArchived: true }),
    listCurrencies(),
    listTransactions({
      walletId: id,
      limit: 20,
      cursor: typeof cursor === "string" ? cursor : undefined,
    }),
    listTransactions({ walletId: id, deleted: true, limit: 1 }),
  ]);
  if (wallets instanceof Error) return <ReadFailed error={wallets} />;
  if (currencies instanceof Error) return <ReadFailed error={currencies} />;
  if (page instanceof Error) return <ReadFailed error={page} />;
  if (deleted instanceof Error) return <ReadFailed error={deleted} />;
  const wallet = wallets.find((item) => item.id === id);
  if (!wallet) notFound();

  const used = page.transactions.length > 0 || deleted.transactions.length > 0;
  const missing = currencies.filter(
    (currency) =>
      !wallet.balances.some((balance) => balance.currency === currency.code),
  );

  return (
    <main className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>
          {wallet.name}
          {wallet.archivedAt && (
            <span className={styles.muted}> · в архиве</span>
          )}
        </h1>
        <Link href="/finance/transactions/new" className={styles.primary}>
          Новая транзакция
        </Link>
      </div>
      {wallet.note && <p className={styles.muted}>{wallet.note}</p>}
      {formError(error) && (
        <p className={styles.error} role="alert">
          {formError(error)}
        </p>
      )}

      <section className={styles.card} aria-label="Остатки">
        <h2 className={styles.subtitle}>Остатки</h2>
        {wallet.balances.length === 0 && (
          <p className={styles.muted}>Валют пока нет.</p>
        )}
        {wallet.balances.map((balance) => (
          <div key={balance.currency} className={styles.row}>
            <span>{balance.currency}</span>
            <span className={styles.amount}>
              {money(balance.amount, balance.currency, currencies)}
            </span>
          </div>
        ))}
        {missing.length > 0 && (
          <form
            className={styles.inline}
            action={addWalletCurrencyAction.bind(null, wallet.id)}
          >
            <select name="currency" aria-label="Валюта для кошелька">
              {missing.map((currency) => (
                <option key={currency.code} value={currency.code}>
                  {currency.code}
                </option>
              ))}
            </select>
            <button className={styles.secondary} type="submit">
              Добавить валюту
            </button>
          </form>
        )}
      </section>

      <section className={styles.card}>
        <h2 className={styles.subtitle}>Транзакции</h2>
        <TransactionsTable
          transactions={page.transactions}
          currencies={currencies}
        />
        {page.nextCursor && (
          <Link
            href={`/finance/wallets/${wallet.id}?cursor=${encodeURIComponent(page.nextCursor)}`}
          >
            Ещё
          </Link>
        )}
      </section>

      <section className={styles.card}>
        <h2 className={styles.subtitle}>Кошелёк</h2>
        <form
          className={styles.inline}
          action={updateWalletAction.bind(null, wallet.id)}
        >
          <label className={styles.field}>
            Имя
            <input name="name" defaultValue={wallet.name} />
          </label>
          <label className={styles.field}>
            Заметка
            <input name="note" defaultValue={wallet.note ?? ""} />
          </label>
          <button className={styles.secondary} type="submit">
            Сохранить
          </button>
        </form>
        <div className={styles.inline}>
          {!wallet.archivedAt && (
            <form action={archiveWalletAction.bind(null, wallet.id)}>
              <button className={styles.secondary} type="submit">
                В архив
              </button>
            </form>
          )}
          {!used && (
            <form action={deleteWalletAction.bind(null, wallet.id)}>
              <ConfirmButton
                className={styles.danger}
                question={`Удалить кошелёк «${wallet.name}»?`}
              >
                Удалить
              </ConfirmButton>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}
