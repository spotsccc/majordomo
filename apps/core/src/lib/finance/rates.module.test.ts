import { balances, currencies, rates, transactions, wallets } from "@repo/db";
import { ValidationError } from "@repo/errors";
import { unwrap } from "@spotsccc/error-as-value";
import { notInArray, sql } from "drizzle-orm";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { db } from "../db";
import { createTransaction, createWallet } from "./finance-store";
import { TransactionInput, trimAmount } from "./money";
import { convert, fetchRates, findCoin, netWorth, ratesOn } from "./rates";

let seededCurrencies: string[] = [];

beforeAll(async () => {
  seededCurrencies = (
    await db.select({ code: currencies.code }).from(currencies)
  ).map(({ code }) => code);
});

beforeEach(async () => {
  await db.delete(rates);
  await db.delete(transactions);
  await db.delete(balances);
  await db.delete(wallets);
  await db
    .delete(currencies)
    .where(notInArray(currencies.code, seededCurrencies));
});

afterEach(() => {
  vi.useRealTimers();
});

const PRICES = {
  bitcoin: { usd: 82375 },
  ethereum: { usd: 2510.3 },
  "usd-coin": { usd: 0.999733 },
  tether: { usd: 0.999168 },
};

const EXCHANGE = {
  rates: {
    btc: { name: "Bitcoin", unit: "BTC", value: 1, type: "crypto" },
    usd: { name: "US Dollar", unit: "$", value: 100, type: "fiat" },
    ars: { name: "Argentine Peso", unit: "$", value: 200000, type: "fiat" },
    gel: { name: "Georgian Lari", unit: "₾", value: 250, type: "fiat" },
    rub: { name: "Russian Ruble", unit: "₽", value: 10000, type: "fiat" },
  },
};

type Answer = Response | Error;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function coingecko(answers: {
  prices?: Answer;
  exchange?: Answer;
  search?: Answer;
}) {
  const calls: { url: string; key: string | null }[] = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    calls.push({
      url: input,
      key: new Headers(init?.headers).get("x-cg-demo-api-key"),
    });
    const path = new URL(input).pathname;
    const answer =
      path === "/api/v3/simple/price"
        ? answers.prices
        : path === "/api/v3/exchange_rates"
          ? answers.exchange
          : path === "/api/v3/search"
            ? answers.search
            : undefined;
    if (answer === undefined) throw new Error(`Неожиданный запрос ${input}`);
    if (answer instanceof Error) throw answer;
    return answer.clone();
  });
  return calls;
}

async function storedRates() {
  const rows = await db
    .select({
      currency: rates.currency,
      date: rates.date,
      usdPerUnit: rates.usdPerUnit,
    })
    .from(rates)
    .orderBy(rates.currency, rates.date);
  return rows.map((row) => ({
    ...row,
    usdPerUnit: trimAmount(row.usdPerUnit),
  }));
}

async function seedRate(currency: string, date: string, usdPerUnit: string) {
  await db.insert(rates).values({
    currency,
    date,
    usdPerUnit,
    source: "coingecko",
    fetchedAt: new Date(),
  });
}

describe("fetchRates", () => {
  it("writes coin prices and fiat rates for the UTC day, sending the Demo key", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-12T23:30:00Z"));
    const calls = coingecko({ prices: json(PRICES), exchange: json(EXCHANGE) });

    const run = unwrap(await fetchRates());

    expect(run).toEqual({
      date: "2026-10-12",
      updated: ["ARS", "BTC", "ETH", "GEL", "RUB", "USD", "USDC", "USDT"],
      missing: [],
    });
    expect(await storedRates()).toEqual([
      { currency: "ARS", date: "2026-10-12", usdPerUnit: "0.0005" },
      { currency: "BTC", date: "2026-10-12", usdPerUnit: "82375" },
      { currency: "ETH", date: "2026-10-12", usdPerUnit: "2510.3" },
      { currency: "GEL", date: "2026-10-12", usdPerUnit: "0.4" },
      { currency: "RUB", date: "2026-10-12", usdPerUnit: "0.01" },
      { currency: "USD", date: "2026-10-12", usdPerUnit: "1" },
      { currency: "USDC", date: "2026-10-12", usdPerUnit: "0.999733" },
      { currency: "USDT", date: "2026-10-12", usdPerUnit: "0.999168" },
    ]);
    expect(calls.map(({ url }) => url).sort()).toEqual([
      "https://api.coingecko.com/api/v3/exchange_rates",
      "https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&ids=bitcoin%2Cethereum%2Cusd-coin%2Ctether",
    ]);
    expect(calls.map(({ key }) => key)).toEqual(["cg-test-key", "cg-test-key"]);
  });

  it.each([
    [
      "429 with a text body",
      new Response("Throttled", { status: 429 }),
      "CoinGecko ответил 429",
    ],
    ["a 5xx", json({ error: "down" }, 503), "CoinGecko ответил 503"],
    [
      "a timeout",
      new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      ),
      "CoinGecko не ответил за 10 с",
    ],
    [
      "a body that is not JSON",
      new Response("<html>"),
      "Неверный ответ CoinGecko",
    ],
    [
      "a JSON of another shape",
      json({ tether: 1 }),
      "Неверный ответ CoinGecko",
    ],
  ])(
    "keeps fiat rates when coin prices fail with %s (P17)",
    async (_, answer, reason) => {
      coingecko({ prices: answer, exchange: json(EXCHANGE) });

      const run = unwrap(await fetchRates());

      expect(run.updated).toEqual(["ARS", "GEL", "RUB", "USD"]);
      expect(run.missing).toEqual(
        ["BTC", "ETH", "USDC", "USDT"].map((currency) => ({
          currency,
          reason,
        })),
      );
      expect((await storedRates()).map(({ currency }) => currency)).toEqual(
        run.updated,
      );
    },
  );

  it("keeps coin prices when exchange_rates fails (P17)", async () => {
    coingecko({ prices: json(PRICES), exchange: json({}, 500) });

    const run = unwrap(await fetchRates());

    expect(run.updated).toEqual(["BTC", "ETH", "USDC", "USDT"]);
    expect(run.missing.map(({ currency }) => currency)).toEqual([
      "ARS",
      "GEL",
      "RUB",
      "USD",
    ]);
  });

  it("names a coin and a fiat currency that the answers leave out", async () => {
    const { ethereum: _, ...withoutEthereum } = PRICES;
    const { gel: __, ...withoutLari } = EXCHANGE.rates;
    coingecko({
      prices: json(withoutEthereum),
      exchange: json({ rates: withoutLari }),
    });

    const run = unwrap(await fetchRates());

    expect(run.missing).toEqual([
      { currency: "ETH", reason: "CoinGecko не вернул цену ethereum" },
      { currency: "GEL", reason: "В exchange_rates CoinGecko нет GEL" },
    ]);
  });

  it("overwrites the rate of the day on a second run and keeps other days", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
    coingecko({ prices: json(PRICES), exchange: json(EXCHANGE) });
    unwrap(await fetchRates());
    vi.setSystemTime(new Date("2026-10-12T04:37:00Z"));
    unwrap(await fetchRates());

    coingecko({
      prices: json({ ...PRICES, bitcoin: { usd: 90000 } }),
      exchange: json(EXCHANGE),
    });
    unwrap(await fetchRates());

    expect(
      (await storedRates()).filter(({ currency }) => currency === "BTC"),
    ).toEqual([
      { currency: "BTC", date: "2026-10-11", usdPerUnit: "82375" },
      { currency: "BTC", date: "2026-10-12", usdPerUnit: "90000" },
    ]);
  });

  it("asks for a coin added later by its CoinGecko id", async () => {
    await db.insert(currencies).values({
      code: "SOL",
      name: "Solana",
      kind: "crypto",
      scale: 9,
      rateSource: "coin",
      rateId: "solana",
    });
    const calls = coingecko({
      prices: json({ ...PRICES, solana: { usd: 150 } }),
      exchange: json(EXCHANGE),
    });

    const run = unwrap(await fetchRates());

    expect(run.updated).toContain("SOL");
    expect(
      calls.find(({ url }) => url.includes("simple/price"))?.url,
    ).toContain("ids=bitcoin%2Cethereum%2Csolana%2Cusd-coin%2Ctether");
  });
});

describe("findCoin", () => {
  it("returns the coins with the same ticker, by market cap rank (P11)", async () => {
    coingecko({
      search: json({
        coins: [
          { id: "usdtb", name: "USDtb", symbol: "USDTB", market_cap_rank: 122 },
          {
            id: "bridged-usdt",
            name: "Bridged USDT",
            symbol: "USDT",
            market_cap_rank: null,
          },
          { id: "tether", name: "Tether", symbol: "USDT", market_cap_rank: 3 },
          {
            id: "usdt-wormhole",
            name: "USDT (Wormhole)",
            symbol: "USDT",
            market_cap_rank: 900,
          },
        ],
        exchanges: [],
      }),
    });

    expect(unwrap(await findCoin("usdt"))).toEqual([
      { id: "tether", name: "Tether", symbol: "USDT", rank: 3 },
      {
        id: "usdt-wormhole",
        name: "USDT (Wormhole)",
        symbol: "USDT",
        rank: 900,
      },
      { id: "bridged-usdt", name: "Bridged USDT", symbol: "USDT", rank: null },
    ]);
  });

  it("returns the CoinGecko failure as a value", async () => {
    coingecko({ search: new Response("Throttled", { status: 429 }) });

    expect(await findCoin("SOL")).toBeInstanceOf(Error);
  });
});

describe("convert", () => {
  async function converted(
    amount: string,
    from: string,
    to: string,
    day: string,
  ) {
    const { value, approximate, ratesDate } = convert(
      sql`${amount}::numeric`,
      sql`${from}::text`,
      to,
      sql`${day}::date`,
    );
    const result = await db.execute(
      sql`select ${value}::text as value, ${approximate} as approximate, ${ratesDate}::text as rates_date`,
    );
    const [row] = result.rows;
    return {
      value: typeof row?.value === "string" ? trimAmount(row.value) : null,
      approximate: row?.approximate ?? null,
      ratesDate: row?.rates_date ?? null,
    };
  }

  beforeEach(async () => {
    await seedRate("ARS", "2026-09-10", "0.001");
    await seedRate("ARS", "2026-09-20", "0.0008");
    await seedRate("USD", "2026-09-10", "1");
    await seedRate("USDC", "2026-09-10", "0.5");
  });

  it("divides the dollar prices of the two currencies (P15)", async () => {
    expect(await converted("100", "ARS", "USDC", "2026-09-10")).toEqual({
      value: "0.2",
      approximate: false,
      ratesDate: "2026-09-10",
    });
  });

  it.each([
    ["the rate of the day", "2026-09-20", "0.08", false, "2026-09-10"],
    [
      "the latest rate before the day",
      "2026-09-15",
      "0.1",
      false,
      "2026-09-10",
    ],
    [
      "the earliest rate after the day, as an approximation",
      "2026-09-01",
      "0.1",
      true,
      "2026-09-10",
    ],
  ])("takes %s (P16)", async (_, day, value, approximate, ratesDate) => {
    expect(await converted("100", "ARS", "USD", day)).toEqual({
      value,
      approximate,
      ratesDate,
    });
  });

  it("leaves out a currency without any rate and never equates USDT with USD (P13)", async () => {
    expect(
      (await converted("100", "USDT", "USD", "2026-09-10")).value,
    ).toBeNull();
    expect(
      (await converted("100", "USD", "USDT", "2026-09-10")).value,
    ).toBeNull();
  });

  it("keeps an amount in its own currency without a rate", async () => {
    expect(await converted("100", "GEL", "GEL", "2026-09-10")).toEqual({
      value: "100",
      approximate: false,
      ratesDate: null,
    });
  });
});

describe("netWorth", () => {
  it("sums every balance in one currency and names the currencies without a rate (S5)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T15:00:00Z"));
    const cash = unwrap(await createWallet({ name: "Наличные" })).id;
    const binance = unwrap(await createWallet({ name: "Binance" })).id;
    for (const [walletId, currency, amount] of [
      [cash, "ARS", "200000"],
      [cash, "USD", "100"],
      [binance, "USDT", "50"],
      [binance, "GEL", "10"],
    ] as const) {
      unwrap(
        await createTransaction(
          TransactionInput.parse({
            type: "income",
            to: { walletId, currency, amount },
          }),
        ),
      );
    }
    await createWallet({ name: "Пустой", currencies: ["RUB"] });
    await seedRate("ARS", "2026-10-08", "0.0005");
    await seedRate("USD", "2026-10-08", "1");
    await seedRate("USDT", "2026-10-07", "0.999");
    await seedRate("USDT", "2026-10-09", "2");

    expect(unwrap(await netWorth("USD"))).toEqual({
      currency: "USD",
      amount: "249.95",
      ratesDate: "2026-10-07",
      missing: ["GEL"],
    });
    expect(unwrap(await netWorth("ARS"))).toMatchObject({
      amount: "499900",
      missing: ["GEL"],
    });
    expect(await netWorth("XYZ")).toBeInstanceOf(ValidationError);
  });
});

describe("ratesOn", () => {
  it("prices every currency in one currency on a day and names those without a rate", async () => {
    await seedRate("ARS", "2026-09-10", "0.001");
    await seedRate("USD", "2026-09-10", "1");
    await seedRate("USDT", "2026-09-20", "0.999");

    expect(unwrap(await ratesOn("USD", "2026-09-15"))).toEqual({
      currency: "USD",
      date: "2026-09-15",
      rates: [
        {
          currency: "ARS",
          rate: "0.001",
          ratesDate: "2026-09-10",
          approximate: false,
        },
        {
          currency: "USDT",
          rate: "0.999",
          ratesDate: "2026-09-10",
          approximate: true,
        },
      ],
      missing: ["BTC", "ETH", "GEL", "RUB", "USDC"],
    });
    expect(await ratesOn("XYZ", "2026-09-15")).toBeInstanceOf(ValidationError);
  });
});
