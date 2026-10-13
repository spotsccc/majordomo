import { z } from "zod";

export function trimAmount(amount: string): string {
  return amount.includes(".") ? amount.replace(/\.?0+$/, "") : amount;
}

/** A string, not a number: a JavaScript number keeps about 16 significant digits, and an ETH amount has up to 38. */
export const Amount = z
  .string()
  .regex(/^(0|[1-9]\d{0,19})(\.\d+)?$/, "сумма — число с точкой: 3500.50")
  .transform(trimAmount)
  .refine((amount) => amount !== "0", "сумма больше нуля")
  .refine(
    (amount) => fractionDigits(amount) <= 18,
    "не больше 18 знаков после точки",
  );

export function normalizeAmount(text: string): string {
  const compact = text.replace(/\s/g, "");
  return compact.includes(".")
    ? compact.replaceAll(",", "")
    : compact.replace(",", ".");
}

export function fractionDigits(amount: string): number {
  return amount.split(".")[1]?.length ?? 0;
}

export const CurrencyCode = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, "код валюты заглавными буквами: USD, USDT");

/** `formatAmount` shows fiat in the currency style of `Intl.NumberFormat`, which accepts only ISO 4217 codes. */
export const NewCurrency = z
  .strictObject({
    code: CurrencyCode,
    name: z.string().trim().min(1),
    kind: z.enum(["fiat", "crypto"]),
    scale: z.int().min(0).max(18),
    rateId: z.string().trim().min(1).optional(),
  })
  .refine(
    (currency) =>
      currency.kind === "crypto" || /^[A-Z]{3}$/.test(currency.code),
    { message: "код фиатной валюты — три буквы ISO 4217", path: ["code"] },
  )
  .refine(
    (currency) =>
      (currency.kind === "crypto") === (currency.rateId !== undefined),
    {
      message: "у криптовалюты — id монеты CoinGecko, у фиата его нет",
      path: ["rateId"],
    },
  );

export type NewCurrency = z.output<typeof NewCurrency>;

const Side = z.strictObject({
  walletId: z.uuid(),
  currency: CurrencyCode,
  amount: Amount,
});

const Fee = z.strictObject({ currency: CurrencyCode, amount: Amount });

const occurredAt = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value))
  .optional();

const note = z.string().trim().min(1).optional();

export const TransactionInput = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("income"), to: Side, occurredAt, note }),
  z.strictObject({
    type: z.literal("expense"),
    from: Side,
    fee: Fee.optional(),
    categoryId: z.uuid(),
    occurredAt,
    note,
  }),
  z
    .strictObject({
      type: z.literal("transfer"),
      from: Side,
      to: Side,
      fee: Fee.optional(),
      occurredAt,
      note,
    })
    .refine(
      ({ from, to }) =>
        from.walletId !== to.walletId || from.currency !== to.currency,
      {
        message: "перевод не может идти в тот же кошелёк и ту же валюту",
        path: ["to"],
      },
    )
    .refine(
      ({ from, to }) =>
        from.currency !== to.currency || from.amount === to.amount,
      {
        message: "в одной валюте суммы сторон равны; комиссию передайте в fee",
        path: ["to", "amount"],
      },
    ),
  z
    .strictObject({
      type: z.literal("adjustment"),
      from: Side.optional(),
      to: Side.optional(),
      occurredAt,
      note,
    })
    .refine(
      ({ from, to }) => (from === undefined) !== (to === undefined),
      "у корректировки ровно одна сторона: from или to",
    ),
]);

export type TransactionInput = z.output<typeof TransactionInput>;

/**
 * Formats the decimal string itself: converting it to a number first would round an 18-digit
 * amount.
 */
export function formatAmount(
  amount: string,
  currency: { code: string; kind: "fiat" | "crypto"; scale: number },
): string {
  if (!isDecimal(amount)) return `${amount}\u00a0${currency.code}`;
  if (currency.kind === "crypto") {
    const number = new Intl.NumberFormat("ru-RU", {
      maximumFractionDigits: currency.scale,
    }).format(amount);
    return `${number}\u00a0${currency.code}`;
  }
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: currency.code,
    currencyDisplay: "code",
    minimumFractionDigits: currency.scale,
    maximumFractionDigits: currency.scale,
    trailingZeroDisplay: "stripIfInteger",
  }).format(amount);
}

function isDecimal(amount: string): amount is `${number}` {
  return /^\d+(\.\d+)?$/.test(amount);
}
