import { balances, currencies, rates } from "@repo/db";
import { ValidationError } from "@repo/errors";
import {
  eq,
  gt,
  isNotNull,
  ne,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { z } from "zod";
import { config } from "../config";
import { db } from "../db";
import { trimAmount } from "./money";

const API = "https://api.coingecko.com/api/v3";
const TIMEOUT_MS = 10_000;

const CoinPrices = z.record(
  z.string(),
  z.object({ usd: z.number().positive() }),
);

const ExchangeRates = z.object({
  rates: z.record(z.string(), z.object({ value: z.number().positive() })),
});

const NO_PRICES: z.infer<typeof CoinPrices> = {};
const NO_RATES: z.infer<typeof ExchangeRates> = { rates: {} };

const SearchResult = z.object({
  coins: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      symbol: z.string(),
      market_cap_rank: z.number().nullable(),
    }),
  ),
});

export type RatesRun = {
  date: string;
  updated: string[];
  missing: { currency: string; reason: string }[];
};

/**
 * The two requests are independent: a failed one leaves its currencies in `missing` and the other
 * one's rates are still written. A second run on the same UTC day overwrites that day's rates.
 */
export async function fetchRates(): Promise<Error | RatesRun> {
  const listed = await db
    .select({
      code: currencies.code,
      rateSource: currencies.rateSource,
      rateId: currencies.rateId,
    })
    .from(currencies)
    .where(isNotNull(currencies.rateSource))
    .orderBy(currencies.code)
    .catch(
      (cause: unknown) => new Error("Не удалось прочитать валюты", { cause }),
    );
  if (listed instanceof Error) return listed;

  const coins = listed.flatMap(({ code, rateSource, rateId }) =>
    rateSource === "coin" && rateId ? [{ code, rateId }] : [],
  );
  const fiats = listed.filter(({ rateSource }) => rateSource === "fiat");
  const [prices, exchange] = await Promise.all([
    coins.length > 0
      ? getJson(
          `${API}/simple/price?vs_currencies=usd&ids=${encodeURIComponent(
            coins.map(({ rateId }) => rateId).join(","),
          )}`,
          CoinPrices,
        )
      : NO_PRICES,
    fiats.length > 0
      ? getJson(`${API}/exchange_rates`, ExchangeRates)
      : NO_RATES,
  ]);

  const found: { currency: string; usdPerUnit: SQL }[] = [];
  const missing: RatesRun["missing"] = [];
  for (const { code, rateId } of coins) {
    const price = prices instanceof Error ? undefined : prices[rateId]?.usd;
    if (price === undefined) {
      missing.push({
        currency: code,
        reason:
          prices instanceof Error
            ? prices.message
            : `CoinGecko не вернул цену ${rateId}`,
      });
    } else {
      found.push({
        currency: code,
        usdPerUnit: sql`${String(price)}::numeric`,
      });
    }
  }
  for (const { code } of fiats) {
    const usd = exchange instanceof Error ? undefined : exchange.rates.usd;
    const unit =
      exchange instanceof Error
        ? undefined
        : exchange.rates[code.toLowerCase()];
    if (!usd || !unit) {
      missing.push({
        currency: code,
        reason:
          exchange instanceof Error
            ? exchange.message
            : `В exchange_rates CoinGecko нет ${code}`,
      });
    } else {
      found.push({
        currency: code,
        usdPerUnit: sql`${String(usd.value)}::numeric / ${String(unit.value)}::numeric`,
      });
    }
  }

  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  if (found.length > 0) {
    const written = await db
      .insert(rates)
      .values(
        found.map(({ currency, usdPerUnit }) => ({
          currency,
          date,
          usdPerUnit,
          source: "coingecko" as const,
          fetchedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [rates.currency, rates.date],
        set: {
          usdPerUnit: sql`excluded.usd_per_unit`,
          source: sql`excluded.source`,
          fetchedAt: sql`excluded.fetched_at`,
        },
      })
      .catch(
        (cause: unknown) => new Error("Не удалось записать курсы", { cause }),
      );
    if (written instanceof Error) return written;
  }
  return {
    date,
    updated: found.map(({ currency }) => currency).sort(),
    missing: missing.sort((a, b) => a.currency.localeCompare(b.currency)),
  };
}

export type Coin = {
  id: string;
  name: string;
  symbol: string;
  rank: number | null;
};

/** Dozens of CoinGecko coins share a ticker, so the owner picks one of these by its id. */
export async function findCoin(symbol: string): Promise<Error | Coin[]> {
  const result = await getJson(
    `${API}/search?query=${encodeURIComponent(symbol)}`,
    SearchResult,
  );
  if (result instanceof Error) return result;
  return result.coins
    .filter((coin) => coin.symbol.toUpperCase() === symbol.toUpperCase())
    .map(({ id, name, symbol: ticker, market_cap_rank }) => ({
      id,
      name,
      symbol: ticker,
      rank: market_cap_rank,
    }))
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
}

/**
 * П15 and П16: the rate of the day, else the latest before it, else the earliest after it, which
 * makes the result approximate. `value` is null when either currency has no rate at all.
 */
export function convert(
  amount: SQLWrapper,
  from: SQLWrapper,
  to: string,
  day: SQLWrapper,
): {
  value: SQL<string | null>;
  approximate: SQL<boolean>;
  ratesDate: SQL<string | null>;
} {
  const same = sql`${from} = ${to}`;
  const pick = (currency: SQLWrapper, column: SQL) =>
    sql`(select ${column} from ${rates} where ${rates.currency} = ${currency} order by ${rates.date} > ${day}, abs(${rates.date} - ${day}) limit 1)`;
  const fromRate = pick(from, sql`${rates.usdPerUnit}`);
  const toRate = pick(sql`${to}`, sql`${rates.usdPerUnit}`);
  const fromDate = pick(from, sql`${rates.date}`);
  const toDate = pick(sql`${to}`, sql`${rates.date}`);
  return {
    value: sql<
      string | null
    >`case when ${same} then ${amount} else ${amount} * ${fromRate} / ${toRate} end`,
    approximate: sql<boolean>`(not ${same} and (${fromDate} > ${day} or ${toDate} > ${day}))`,
    ratesDate: sql<
      string | null
    >`case when ${same} then null else least(${fromDate}, ${toDate}) end`,
  };
}

export type NetWorth = {
  currency: string;
  amount: string;
  ratesDate: string | null;
  missing: string[];
};

/** Archived wallets count too: their money is still the owner's. */
export async function netWorth(inCurrency: string): Promise<Error | NetWorth> {
  const scale = await scaleOf(inCurrency);
  if (scale instanceof Error) return scale;

  const today = sql`${new Date().toISOString().slice(0, 10)}::date`;
  const { value, ratesDate } = convert(
    balances.amount,
    balances.currency,
    inCurrency,
    today,
  );
  const rows = await db
    .select({
      amount: sql<string>`round(coalesce(sum(${value}), 0), ${scale})::text`,
      ratesDate: sql<
        string | null
      >`min(${ratesDate}) filter (where ${value} is not null)::text`,
      missing: sql<
        string[]
      >`coalesce(array_agg(distinct ${balances.currency}) filter (where ${value} is null), '{}')`,
    })
    .from(balances)
    .where(gt(balances.amount, "0"))
    .catch(
      (cause: unknown) => new Error("Не удалось посчитать итог", { cause }),
    );
  if (rows instanceof Error) return rows;
  const [row] = rows;
  return {
    currency: inCurrency,
    amount: trimAmount(row?.amount ?? "0"),
    ratesDate: row?.ratesDate ?? null,
    missing: (row?.missing ?? []).sort(),
  };
}

export type Rate = {
  currency: string;
  rate: string;
  ratesDate: string;
  approximate: boolean;
};

/** `date` is a UTC day, like the days of the rates. */
export async function ratesOn(
  inCurrency: string,
  date: string,
): Promise<
  Error | { currency: string; date: string; rates: Rate[]; missing: string[] }
> {
  const scale = await scaleOf(inCurrency);
  if (scale instanceof Error) return scale;

  const { value, approximate, ratesDate } = convert(
    sql`1::numeric`,
    currencies.code,
    inCurrency,
    sql`${date}::date`,
  );
  const rows = await db
    .select({
      currency: currencies.code,
      rate: sql<string | null>`round(${value}, 18)::text`,
      ratesDate: sql<string | null>`${ratesDate}::text`,
      approximate,
    })
    .from(currencies)
    .where(ne(currencies.code, inCurrency))
    .orderBy(currencies.code)
    .catch(
      (cause: unknown) => new Error("Не удалось прочитать курсы", { cause }),
    );
  if (rows instanceof Error) return rows;
  return {
    currency: inCurrency,
    date,
    rates: rows.flatMap(
      ({ currency, rate, ratesDate: day, approximate: near }) =>
        rate === null || day === null
          ? []
          : [
              {
                currency,
                rate: trimAmount(rate),
                ratesDate: day,
                approximate: near,
              },
            ],
    ),
    missing: rows
      .filter(({ rate }) => rate === null)
      .map(({ currency }) => currency),
  };
}

export async function scaleOf(code: string): Promise<Error | number> {
  const rows = await db
    .select({ scale: currencies.scale })
    .from(currencies)
    .where(eq(currencies.code, code))
    .catch(
      (cause: unknown) => new Error("Не удалось прочитать валюту", { cause }),
    );
  if (rows instanceof Error) return rows;
  return (
    rows[0]?.scale ??
    new ValidationError({ message: `Валюты ${code} нет в справочнике` })
  );
}

async function getJson<T>(
  url: string,
  schema: z.ZodType<T>,
): Promise<Error | T> {
  const key = config.COINGECKO_API_KEY;
  const response = await fetch(url, {
    headers: key ? { "x-cg-demo-api-key": key } : {},
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(
    (cause: unknown) =>
      new Error(
        cause instanceof DOMException && cause.name === "TimeoutError"
          ? `CoinGecko не ответил за ${TIMEOUT_MS / 1000} с`
          : "CoinGecko недоступен",
        { cause },
      ),
  );
  if (response instanceof Error) return response;
  if (!response.ok) return new Error(`CoinGecko ответил ${response.status}`);
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = schema.safeParse(body);
  return parsed.success
    ? parsed.data
    : new Error("Неверный ответ CoinGecko", { cause: parsed.error });
}
