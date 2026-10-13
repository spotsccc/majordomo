import Link from "next/link";
import { requireOwnerSession } from "@/lib/auth";
import {
  listCategories,
  listCurrencies,
  listWallets,
} from "@/lib/finance/finance-store";
import { ownerIsoDateTime } from "@/lib/owner-time";
import { createTransactionAction } from "../../actions";
import styles from "../../finance.module.css";
import { ReadFailed } from "../../read-failed";
import { TransactionForm } from "../../transaction-form";

export const metadata = { title: "Новая транзакция — Majordomo" };

export default async function NewTransactionPage() {
  await requireOwnerSession();
  const [wallets, categories, currencies] = await Promise.all([
    listWallets(),
    listCategories(),
    listCurrencies(),
  ]);
  if (wallets instanceof Error) return <ReadFailed error={wallets} />;
  if (categories instanceof Error) return <ReadFailed error={categories} />;
  if (currencies instanceof Error) return <ReadFailed error={currencies} />;

  const [first, second] = wallets;
  if (!first) {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>Новая транзакция</h1>
        <p>
          Кошельков пока нет.{" "}
          <Link href="/finance/wallets/new">Создайте кошелёк</Link>.
        </p>
      </main>
    );
  }
  const currency = first.balances[0]?.currency ?? currencies[0]?.code ?? "USD";

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Новая транзакция</h1>
      <TransactionForm
        action={createTransactionAction}
        submitLabel="Записать"
        wallets={wallets.map((wallet) => ({
          id: wallet.id,
          name: wallet.name,
          archived: false,
          balances: wallet.balances,
        }))}
        categories={categories}
        currencies={currencies}
        initial={{
          type: "expense",
          wallet: first.id,
          currency,
          amount: "",
          toWallet: (second ?? first).id,
          toCurrency: currency,
          toAmount: "",
          feeCurrency: currency,
          feeAmount: "",
          category: "",
          newCategory: "",
          direction: "in",
          // oxlint-disable-next-line react/purity -- a Server Component renders once per request, so the time is fixed for the whole page
          occurredAt: ownerIsoDateTime(new Date()).slice(0, 16),
          note: "",
        }}
      />
    </main>
  );
}
