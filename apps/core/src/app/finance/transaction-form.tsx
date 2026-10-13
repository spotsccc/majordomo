"use client";

import {
  startTransition,
  useActionState,
  useId,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { normalizeAmount } from "@/lib/finance/money";
import styles from "./finance.module.css";
import {
  money,
  TYPE_LABELS,
  type CurrencyInfo,
  type TransactionType,
} from "./format";

export type FormField =
  | "amount"
  | "toAmount"
  | "feeAmount"
  | "category"
  | "occurredAt"
  | "form";

export type FormState = { field: FormField; message: string } | null;

export type FormValues = {
  type: TransactionType;
  wallet: string;
  currency: string;
  amount: string;
  toWallet: string;
  toCurrency: string;
  toAmount: string;
  feeCurrency: string;
  feeAmount: string;
  category: string;
  newCategory: string;
  direction: "in" | "out";
  occurredAt: string;
  note: string;
};

export type WalletOption = {
  id: string;
  name: string;
  archived: boolean;
  balances: { currency: string; amount: string }[];
};

const TYPES: TransactionType[] = [
  "expense",
  "income",
  "transfer",
  "adjustment",
];

const rateFormat = new Intl.NumberFormat("ru-RU", {
  maximumSignificantDigits: 6,
});

/**
 * Inputs are controlled and the action is started from `onSubmit`: React resets a form whose
 * `action` prop finishes, which would erase the amount next to its error.
 */
export function TransactionForm({
  action,
  initial,
  wallets,
  categories,
  currencies,
  submitLabel,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  initial: FormValues;
  wallets: WalletOption[];
  categories: { id: string; name: string }[];
  currencies: CurrencyInfo[];
  submitLabel: string;
}) {
  const [values, setValues] = useState(initial);
  const uid = useId();
  const idOf = (name: keyof FormValues) => `${uid}${name}`;
  const [state, formAction, pending] = useActionState(action, null);

  const change =
    (name: keyof FormValues) =>
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setValues((current) => ({ ...current, [name]: event.target.value }));
  const normalize = (name: "amount" | "toAmount" | "feeAmount") => () =>
    setValues((current) => ({
      ...current,
      [name]: normalizeAmount(current[name]),
    }));
  const chooseWallet = (event: ChangeEvent<HTMLSelectElement>) => {
    const wallet = wallets.find((item) => item.id === event.target.value);
    setValues((current) => {
      const codes = wallet?.balances.map((balance) => balance.currency) ?? [];
      const currency =
        codes.length > 0 && !codes.includes(current.currency)
          ? (codes[0] ?? current.currency)
          : current.currency;
      return { ...current, wallet: event.target.value, currency };
    });
  };

  const { type } = values;
  const debit =
    type === "expense" ||
    type === "transfer" ||
    (type === "adjustment" && values.direction === "out");
  const hasFee = type === "expense" || type === "transfer";
  const exchange = type === "transfer" && values.toCurrency !== values.currency;
  const sameBalance =
    type === "transfer" &&
    values.wallet === values.toWallet &&
    values.currency === values.toCurrency;
  const balance = wallets
    .find((wallet) => wallet.id === values.wallet)
    ?.balances.find((item) => item.currency === values.currency);
  const rate = exchange
    ? exchangeRate(values.amount, values.toAmount)
    : undefined;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  };

  const error = (field: FormField) =>
    state?.field === field ? (
      <p className={styles.error} role="alert">
        {state.message}
      </p>
    ) : null;
  const walletOptions = wallets.map((wallet) => (
    <option key={wallet.id} value={wallet.id}>
      {wallet.archived ? `${wallet.name} (архив)` : wallet.name}
    </option>
  ));
  const currencyOptions = currencies.map((currency) => (
    <option key={currency.code} value={currency.code}>
      {currency.code}
    </option>
  ));

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className={styles.tabs} role="group" aria-label="Вид транзакции">
        {TYPES.map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={item === type}
            onClick={() => setValues((current) => ({ ...current, type: item }))}
          >
            {TYPE_LABELS[item]}
          </button>
        ))}
      </div>
      <input type="hidden" name="type" value={type} />
      <input
        type="hidden"
        name="occurredAtInitial"
        value={initial.occurredAt}
      />

      {type === "adjustment" && (
        <div className={styles.field}>
          <label htmlFor={idOf("direction")}>Направление</label>
          <select
            id={idOf("direction")}
            name="direction"
            value={values.direction}
            onChange={change("direction")}
          >
            <option value="in">Зачислить</option>
            <option value="out">Списать</option>
          </select>
        </div>
      )}

      <div className={styles.side}>
        <div className={styles.field}>
          <label htmlFor={idOf("wallet")}>
            {type === "transfer" ? "Откуда" : "Кошелёк"}
          </label>
          <select
            id={idOf("wallet")}
            name="wallet"
            value={values.wallet}
            onChange={chooseWallet}
          >
            {walletOptions}
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor={idOf("currency")}>Валюта</label>
          <select
            id={idOf("currency")}
            name="currency"
            value={values.currency}
            onChange={change("currency")}
          >
            {currencyOptions}
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor={idOf("amount")}>Сумма</label>
          <input
            id={idOf("amount")}
            name="amount"
            inputMode="decimal"
            autoComplete="off"
            value={values.amount}
            aria-invalid={state?.field === "amount"}
            onChange={change("amount")}
            onBlur={normalize("amount")}
          />
        </div>
      </div>
      {debit && balance && (
        <p className={styles.hint}>
          Остаток: {money(balance.amount, balance.currency, currencies)}
        </p>
      )}
      {error("amount")}

      {type === "transfer" && (
        <>
          <div className={styles.side}>
            <div className={styles.field}>
              <label htmlFor={idOf("toWallet")}>Куда</label>
              <select
                id={idOf("toWallet")}
                name="toWallet"
                value={values.toWallet}
                onChange={change("toWallet")}
              >
                {walletOptions}
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor={idOf("toCurrency")}>Валюта зачисления</label>
              <select
                id={idOf("toCurrency")}
                name="toCurrency"
                value={values.toCurrency}
                onChange={change("toCurrency")}
              >
                {currencyOptions}
              </select>
            </div>
            {exchange && (
              <div className={styles.field}>
                <label htmlFor={idOf("toAmount")}>Сумма зачисления</label>
                <input
                  id={idOf("toAmount")}
                  name="toAmount"
                  inputMode="decimal"
                  autoComplete="off"
                  value={values.toAmount}
                  aria-invalid={state?.field === "toAmount"}
                  onChange={change("toAmount")}
                  onBlur={normalize("toAmount")}
                />
              </div>
            )}
          </div>
          {rate && (
            <p className={styles.hint}>
              Курс: 1 {values.currency} = {rate} {values.toCurrency}
            </p>
          )}
          {sameBalance && (
            <p className={styles.error} role="alert">
              Перевод в тот же кошелёк и ту же валюту невозможен. Для обмена
              выберите другую валюту.
            </p>
          )}
          {error("toAmount")}
        </>
      )}

      {type === "expense" && (
        <>
          <div className={styles.field}>
            <label htmlFor={idOf("category")}>Категория</label>
            <select
              id={idOf("category")}
              name="category"
              value={values.category}
              aria-invalid={state?.field === "category"}
              onChange={change("category")}
            >
              <option value="" disabled>
                Выберите категорию
              </option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
              <option value="new">+ Новая категория</option>
            </select>
          </div>
          {values.category === "new" && (
            <div className={styles.field}>
              <label htmlFor={idOf("newCategory")}>Имя новой категории</label>
              <input
                id={idOf("newCategory")}
                name="newCategory"
                autoComplete="off"
                value={values.newCategory}
                onChange={change("newCategory")}
              />
            </div>
          )}
          {error("category")}
        </>
      )}

      {hasFee && (
        <>
          <div className={styles.side}>
            <div className={styles.field}>
              <label htmlFor={idOf("feeAmount")}>
                Комиссия (необязательно)
              </label>
              <input
                id={idOf("feeAmount")}
                name="feeAmount"
                inputMode="decimal"
                autoComplete="off"
                value={values.feeAmount}
                aria-invalid={state?.field === "feeAmount"}
                onChange={change("feeAmount")}
                onBlur={normalize("feeAmount")}
              />
            </div>
            <div className={styles.field}>
              <label htmlFor={idOf("feeCurrency")}>Валюта комиссии</label>
              <select
                id={idOf("feeCurrency")}
                name="feeCurrency"
                value={values.feeCurrency}
                onChange={change("feeCurrency")}
              >
                {currencyOptions}
              </select>
            </div>
          </div>
          {error("feeAmount")}
        </>
      )}

      <div className={styles.side}>
        <div className={styles.field}>
          <label htmlFor={idOf("occurredAt")}>Когда</label>
          <input
            id={idOf("occurredAt")}
            type="datetime-local"
            name="occurredAt"
            value={values.occurredAt}
            aria-invalid={state?.field === "occurredAt"}
            onChange={change("occurredAt")}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor={idOf("note")}>Заметка</label>
          <input
            id={idOf("note")}
            name="note"
            autoComplete="off"
            value={values.note}
            onChange={change("note")}
          />
        </div>
      </div>
      {error("occurredAt")}
      {error("form")}

      <div>
        <button
          className={styles.primary}
          type="submit"
          disabled={pending || sameBalance}
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function exchangeRate(from: string, to: string): string | undefined {
  const rate = Number(normalizeAmount(to)) / Number(normalizeAmount(from));
  return Number.isFinite(rate) && rate > 0
    ? rateFormat.format(rate)
    : undefined;
}
