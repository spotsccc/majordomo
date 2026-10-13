import Link from "next/link";
import styles from "./finance.module.css";

/** Only links: each page checks the session itself. */
export default function FinanceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <nav className={styles.subnav} aria-label="Финансы">
        <Link href="/finance">Обзор</Link>
        <Link href="/finance/transactions">Транзакции</Link>
        <Link href="/finance/categories">Категории</Link>
        <Link href="/finance/currencies">Валюты</Link>
        <Link href="/finance/wallets/new">Новый кошелёк</Link>
        <Link href="/finance/transactions/new">Новая транзакция</Link>
      </nav>
      {children}
    </>
  );
}
