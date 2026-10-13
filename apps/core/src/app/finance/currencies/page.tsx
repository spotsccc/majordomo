import { requireOwnerSession } from "@/lib/auth";
import { listCurrencies } from "@/lib/finance/finance-store";
import { CurrencyCode } from "@/lib/finance/money";
import { findCoin, ratesOn } from "@/lib/finance/rates";
import { addCurrencyAction } from "../actions";
import styles from "../finance.module.css";
import { formError } from "../form-errors";
import { formatDay } from "../format";
import { ReadFailed } from "../read-failed";

export const metadata = { title: "Валюты — Majordomo" };

const SOURCES = {
  coin: "CoinGecko · simple/price",
  fiat: "CoinGecko · exchange_rates",
};

export default async function CurrenciesPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string | string[];
    symbol?: string | string[];
  }>;
}) {
  await requireOwnerSession();
  const { error, symbol: typed } = await searchParams;
  const [currencies, rates] = await Promise.all([
    listCurrencies(),
    // oxlint-disable-next-line react/purity -- a Server Component renders once per request, so the time is fixed for the whole page
    ratesOn("USD", new Date().toISOString().slice(0, 10)),
  ]);
  if (currencies instanceof Error) return <ReadFailed error={currencies} />;
  if (rates instanceof Error) return <ReadFailed error={rates} />;

  const symbol =
    typeof typed === "string" && typed.trim()
      ? CurrencyCode.safeParse(typed.trim().toUpperCase())
      : undefined;
  const coins = symbol?.success ? await findCoin(symbol.data) : undefined;

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Валюты</h1>
      {formError(error) && (
        <p className={styles.error} role="alert">
          {formError(error)}
        </p>
      )}
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Код</th>
            <th>Название</th>
            <th>Знаков</th>
            <th className={styles.amount}>Курс в USD</th>
            <th>Источник</th>
          </tr>
        </thead>
        <tbody>
          {currencies.map((currency) => {
            const rate = rates.rates.find(
              (item) => item.currency === currency.code,
            );
            return (
              <tr key={currency.code}>
                <td>
                  <b>{currency.code}</b>{" "}
                  <span className={styles.muted}>
                    {currency.kind === "fiat" ? "фиат" : "крипта"}
                  </span>
                </td>
                <td>{currency.name}</td>
                <td>{currency.scale}</td>
                <td className={styles.amount}>
                  {currency.code === "USD"
                    ? "1"
                    : rate
                      ? `${rate.approximate ? "≈ " : ""}${rate.rate}`
                      : "нет курса"}
                  {rate && (
                    <div className={styles.muted}>
                      на {formatDay(rate.ratesDate)}
                    </div>
                  )}
                </td>
                <td className={styles.muted}>
                  {currency.rateSource ? SOURCES[currency.rateSource] : "—"}
                  {currency.rateId && ` · ${currency.rateId}`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <section className={styles.card}>
        <h2 className={styles.subtitle}>Новая фиатная валюта</h2>
        <form className={styles.inline} action={addCurrencyAction}>
          <input type="hidden" name="kind" value="fiat" />
          <label className={styles.field}>
            Код ISO 4217
            <input name="code" placeholder="BRL" maxLength={3} />
          </label>
          <label className={styles.field}>
            Название
            <input name="name" placeholder="Бразильский реал" />
          </label>
          <label className={styles.field}>
            Знаков после запятой
            <input
              name="scale"
              type="number"
              min={0}
              max={18}
              defaultValue={2}
            />
          </label>
          <button className={styles.primary} type="submit">
            Добавить
          </button>
        </form>
      </section>

      <section className={styles.card}>
        <h2 className={styles.subtitle}>Новая криптовалюта</h2>
        <form className={styles.inline} method="get">
          <label className={styles.field}>
            Тикер
            <input
              name="symbol"
              placeholder="SOL"
              defaultValue={typeof typed === "string" ? typed : ""}
            />
          </label>
          <button className={styles.secondary} type="submit">
            Найти в CoinGecko
          </button>
        </form>
        {symbol && !symbol.success && (
          <p className={styles.error}>
            Тикер — заглавные латинские буквы и цифры: SOL, USDT.
          </p>
        )}
        {coins instanceof Error && (
          <p className={styles.error}>
            Не удалось найти монеты: {coins.message}.
          </p>
        )}
        {Array.isArray(coins) && coins.length === 0 && (
          <p className={styles.muted}>В CoinGecko нет монет с этим тикером.</p>
        )}
        {Array.isArray(coins) &&
          symbol?.success &&
          coins.map((coin) => (
            <form
              key={coin.id}
              className={styles.inline}
              action={addCurrencyAction}
            >
              <input type="hidden" name="kind" value="crypto" />
              <input type="hidden" name="code" value={symbol.data} />
              <input type="hidden" name="rateId" value={coin.id} />
              <label className={styles.field}>
                {coin.id}
                {coin.rank !== null && ` · ранг ${coin.rank}`}
                <input
                  name="name"
                  aria-label={`Название ${coin.id}`}
                  defaultValue={coin.name}
                />
              </label>
              <label className={styles.field}>
                Знаков
                <input
                  name="scale"
                  type="number"
                  min={0}
                  max={18}
                  defaultValue={8}
                />
              </label>
              <button className={styles.secondary} type="submit">
                Добавить {coin.name}
              </button>
            </form>
          ))}
      </section>
    </main>
  );
}
