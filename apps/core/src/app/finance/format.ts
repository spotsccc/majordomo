import { formatAmount } from "@/lib/finance/money";

export type CurrencyInfo = {
  code: string;
  name: string;
  kind: "fiat" | "crypto";
  scale: number;
};

export type TransactionType = "income" | "expense" | "transfer" | "adjustment";

export const TYPE_LABELS: Record<TransactionType, string> = {
  expense: "Трата",
  income: "Пополнение",
  transfer: "Перевод",
  adjustment: "Корректировка",
};

export function money(
  amount: string,
  code: string,
  currencies: readonly CurrencyInfo[],
): string {
  const currency = currencies.find((item) => item.code === code) ?? {
    code,
    kind: "crypto" as const,
    scale: 18,
  };
  return formatAmount(amount, currency);
}

const dayFormat = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

export function formatDay(date: string): string {
  return dayFormat.format(new Date(`${date}T00:00:00Z`));
}
