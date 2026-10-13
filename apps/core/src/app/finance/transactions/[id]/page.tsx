import { NotFoundError } from "@repo/errors";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireOwnerSession } from "@/lib/auth";
import {
  getTransaction,
  listCategories,
  listCurrencies,
  listWallets,
  type Transaction,
} from "@/lib/finance/finance-store";
import { ownerIsoDateTime } from "@/lib/owner-time";
import {
  deleteTransactionAction,
  restoreTransactionAction,
  updateTransactionAction,
} from "../../actions";
import { ConfirmButton } from "../../confirm-button";
import styles from "../../finance.module.css";
import { formError } from "../../form-errors";
import { TYPE_LABELS } from "../../format";
import { ReadFailed } from "../../read-failed";
import { TransactionForm, type FormValues } from "../../transaction-form";
import { TransactionsTable } from "../../transactions-table";

export const metadata = { title: "Транзакция — Majordomo" };

export default async function TransactionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  await requireOwnerSession();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const { error } = await searchParams;

  const [transaction, wallets, categories, currencies] = await Promise.all([
    getTransaction(id),
    listWallets({ includeArchived: true }),
    listCategories({ includeArchived: true }),
    listCurrencies(),
  ]);
  if (transaction instanceof NotFoundError) notFound();
  if (transaction instanceof Error) return <ReadFailed error={transaction} />;
  if (wallets instanceof Error) return <ReadFailed error={wallets} />;
  if (categories instanceof Error) return <ReadFailed error={categories} />;
  if (currencies instanceof Error) return <ReadFailed error={currencies} />;

  const notice = formError(error) && (
    <p className={styles.error} role="alert">
      {formError(error)}
    </p>
  );

  if (transaction.deletedAt) {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>
          {TYPE_LABELS[transaction.type]}
          <span className={styles.muted}> · удалена</span>
        </h1>
        {notice}
        <TransactionsTable
          transactions={[transaction]}
          currencies={currencies}
        />
        <form action={restoreTransactionAction.bind(null, transaction.id)}>
          <button className={styles.primary} type="submit">
            Восстановить
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>{TYPE_LABELS[transaction.type]}</h1>
      {notice}
      <TransactionForm
        action={updateTransactionAction.bind(null, transaction.id)}
        submitLabel="Сохранить"
        wallets={wallets.map((wallet) => ({
          id: wallet.id,
          name: wallet.name,
          archived: wallet.archivedAt !== null,
          balances: wallet.balances,
        }))}
        categories={categories.filter(
          (category) =>
            !category.archivedAt || category.id === transaction.category?.id,
        )}
        currencies={currencies}
        initial={formValues(transaction)}
      />
      <form action={deleteTransactionAction.bind(null, transaction.id)}>
        <ConfirmButton
          className={styles.danger}
          question="Удалить транзакцию? Её можно будет восстановить."
        >
          Удалить
        </ConfirmButton>
      </form>
    </main>
  );
}

function formValues(transaction: Transaction): FormValues {
  const { type, from, to, fee } = transaction;
  const main =
    type === "income" ? to : type === "adjustment" ? (to ?? from) : from;
  const currency = main?.currency ?? "";
  return {
    type,
    wallet: main?.walletId ?? "",
    currency,
    amount: main?.amount ?? "",
    toWallet: to?.walletId ?? main?.walletId ?? "",
    toCurrency: to?.currency ?? currency,
    toAmount: to?.amount ?? "",
    feeCurrency: fee?.currency ?? currency,
    feeAmount: fee?.amount ?? "",
    category: transaction.category?.id ?? "",
    newCategory: "",
    direction: type === "adjustment" && from ? "out" : "in",
    occurredAt: ownerIsoDateTime(transaction.occurredAt).slice(0, 16),
    note: transaction.note ?? "",
  };
}
