import { requireOwnerSession } from "@/lib/auth";
import { listCurrencies } from "@/lib/finance/finance-store";
import { createWalletAction } from "../../actions";
import styles from "../../finance.module.css";
import { formError } from "../../form-errors";
import { ReadFailed } from "../../read-failed";

export const metadata = { title: "Новый кошелёк — Majordomo" };

export default async function NewWalletPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  await requireOwnerSession();
  const { error } = await searchParams;
  const currencies = await listCurrencies();
  if (currencies instanceof Error) return <ReadFailed error={currencies} />;

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Новый кошелёк</h1>
      {formError(error) && (
        <p className={styles.error} role="alert">
          {formError(error)}
        </p>
      )}
      <form className={styles.form} action={createWalletAction}>
        <div className={styles.side}>
          <label className={styles.field}>
            Имя
            <input name="name" autoComplete="off" placeholder="Наличные" />
          </label>
          <label className={styles.field}>
            Заметка
            <input name="note" autoComplete="off" />
          </label>
        </div>
        <p className={styles.hint}>
          Отметьте валюты кошелька. Начальный остаток записывается
          корректировкой.
        </p>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Валюта</th>
              <th>Начальный остаток</th>
            </tr>
          </thead>
          <tbody>
            {currencies.map((currency) => (
              <tr key={currency.code}>
                <td>
                  <label>
                    <input type="checkbox" name={`currency.${currency.code}`} />{" "}
                    {currency.code}{" "}
                    <span className={styles.muted}>{currency.name}</span>
                  </label>
                </td>
                <td>
                  <input
                    name={`opening.${currency.code}`}
                    aria-label={`Начальный остаток ${currency.code}`}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div>
          <button className={styles.primary} type="submit">
            Создать кошелёк
          </button>
        </div>
      </form>
    </main>
  );
}
