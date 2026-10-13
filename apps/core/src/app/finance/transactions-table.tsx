import Link from "next/link";
import type { Transaction } from "@/lib/finance/finance-store";
import { formatOwnerShortDateTime } from "@/lib/owner-time";
import styles from "./finance.module.css";
import { money, TYPE_LABELS, type CurrencyInfo } from "./format";

export function TransactionsTable({
  transactions,
  currencies,
}: {
  transactions: Transaction[];
  currencies: CurrencyInfo[];
}) {
  if (transactions.length === 0) {
    return <p className={styles.muted}>Транзакций нет.</p>;
  }
  const amount = (side: { amount: string; currency: string }) =>
    money(side.amount, side.currency, currencies);
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Когда</th>
          <th>Что</th>
          <th className={styles.amount}>Сумма</th>
        </tr>
      </thead>
      <tbody>
        {transactions.map((transaction) => {
          const { from, to, fee } = transaction;
          return (
            <tr
              key={transaction.id}
              className={transaction.deletedAt ? styles.deleted : undefined}
            >
              <td>{formatOwnerShortDateTime(transaction.occurredAt)}</td>
              <td>
                <Link href={`/finance/transactions/${transaction.id}`}>
                  {TYPE_LABELS[transaction.type]}
                  {transaction.category && ` · ${transaction.category.name}`}
                </Link>
                <div className={styles.muted}>
                  {from && to && from.walletId === to.walletId
                    ? `${from.walletName}: обмен`
                    : [from?.walletName, to?.walletName]
                        .filter(Boolean)
                        .join(" → ")}
                  {transaction.note && ` · ${transaction.note}`}
                </div>
              </td>
              <td className={styles.amount}>
                {from && to
                  ? from.currency === to.currency
                    ? amount(from)
                    : `${amount(from)} → ${amount(to)}`
                  : from
                    ? `−${amount(from)}`
                    : to && `+${amount(to)}`}
                {fee && (
                  <div className={styles.muted}>комиссия {amount(fee)}</div>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
