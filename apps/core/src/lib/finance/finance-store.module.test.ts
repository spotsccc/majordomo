import {
  balances,
  categories,
  currencies,
  rates,
  transactions,
  wallets,
} from "@repo/db";
import { NotFoundError, ValidationError } from "@repo/errors";
import { unwrap } from "@spotsccc/error-as-value";
import { notInArray } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db";
import { balanceMismatches } from "./finance.test-utils";
import {
  addCurrency,
  addWalletCurrency,
  archiveCategory,
  archiveWallet,
  createCategory,
  createTransaction,
  createWallet,
  deleteTransaction,
  deleteWallet,
  getTransaction,
  InsufficientFundsError,
  listCategories,
  listTransactions,
  listWallets,
  renameCategory,
  restoreTransaction,
  summarize,
  updateTransaction,
  updateWallet,
} from "./finance-store";
import { TransactionInput } from "./money";

let seededCategories: string[] = [];
let seededCurrencies: string[] = [];

beforeAll(async () => {
  seededCategories = (
    await db.select({ id: categories.id }).from(categories)
  ).map(({ id }) => id);
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
    .delete(categories)
    .where(notInArray(categories.id, seededCategories));
  await db
    .delete(currencies)
    .where(notInArray(currencies.code, seededCurrencies));
});

afterEach(async () => {
  expect(await balanceMismatches()).toEqual([]);
});

const AT = "2026-09-15T12:00:00Z";
const FUNDED_AT = "2026-01-01T00:00:00Z";

function side(walletId: string, currency: string, amount: string) {
  return { walletId, currency, amount };
}

function income(
  walletId: string,
  currency: string,
  amount: string,
  occurredAt = AT,
) {
  return TransactionInput.parse({
    type: "income",
    to: side(walletId, currency, amount),
    occurredAt,
  });
}

function expense(
  walletId: string,
  currency: string,
  amount: string,
  categoryId: string,
  extra: {
    occurredAt?: string;
    note?: string;
    fee?: { currency: string; amount: string };
  } = {},
) {
  return TransactionInput.parse({
    type: "expense",
    from: side(walletId, currency, amount),
    categoryId,
    occurredAt: AT,
    ...extra,
  });
}

function transfer(
  from: [string, string, string],
  to: [string, string, string],
  fee?: { currency: string; amount: string },
) {
  return TransactionInput.parse({
    type: "transfer",
    from: side(...from),
    to: side(...to),
    fee,
    occurredAt: AT,
  });
}

async function wallet(name: string, funds: Record<string, string> = {}) {
  const { id } = unwrap(await createWallet({ name }));
  for (const [currency, amount] of Object.entries(funds)) {
    unwrap(await createTransaction(income(id, currency, amount, FUNDED_AT)));
  }
  return id;
}

async function category(name: string) {
  const found = unwrap(await listCategories({ includeArchived: true })).find(
    (row) => row.name === name,
  );
  return found?.id ?? unwrap(await createCategory(name)).id;
}

async function balanceOf(walletId: string, currency: string) {
  const all = unwrap(await listWallets({ includeArchived: true }));
  return all
    .find((row) => row.id === walletId)
    ?.balances.find((row) => row.currency === currency)?.amount;
}

async function transactionCount() {
  return (await db.select({ id: transactions.id }).from(transactions)).length;
}

describe("createTransaction", () => {
  it("records an expense with its category and returns the new balance (S1)", async () => {
    const cash = await wallet("Наличные", { ARS: "44700" });
    const cafe = await category("Кафе и рестораны");

    const written = unwrap(
      await createTransaction(
        expense(cash, "ARS", "3500", cafe, { note: "кофе" }),
      ),
    );

    expect(written.balances).toEqual([
      { walletId: cash, currency: "ARS", amount: "41200" },
    ]);
    expect(written.transaction).toMatchObject({
      type: "expense",
      from: {
        walletId: cash,
        walletName: "Наличные",
        currency: "ARS",
        amount: "3500",
      },
      to: null,
      fee: null,
      category: { id: cafe, name: "Кафе и рестораны" },
      occurredAt: new Date(AT),
      deletedAt: null,
      note: "кофе",
    });
  });

  it("records an exchange inside one wallet as a transfer (S2)", async () => {
    const cash = await wallet("Наличные", { USD: "500", ARS: "41200" });

    const written = unwrap(
      await createTransaction(
        transfer([cash, "USD", "100"], [cash, "ARS", "151000"]),
      ),
    );

    expect(written.balances).toEqual(
      expect.arrayContaining([
        { walletId: cash, currency: "USD", amount: "400" },
        { walletId: cash, currency: "ARS", amount: "192200" },
      ]),
    );
  });

  it("takes a fee in another currency from the source wallet and opens the target balance (S3)", async () => {
    const binance = await wallet("Binance", { USDT: "500", ETH: "0.1" });
    const trust = await wallet("Trust · Ethereum");

    unwrap(
      await createTransaction(
        transfer([binance, "USDT", "100"], [trust, "USDT", "100"], {
          currency: "ETH",
          amount: "0.0012",
        }),
      ),
    );

    expect(await balanceOf(binance, "USDT")).toBe("400");
    expect(await balanceOf(binance, "ETH")).toBe("0.0988");
    expect(await balanceOf(trust, "USDT")).toBe("100");
  });

  it("adds and subtracts with adjustments", async () => {
    const card = await wallet("Карта", { GEL: "100" });

    unwrap(
      await createTransaction(
        TransactionInput.parse({
          type: "adjustment",
          to: side(card, "GEL", "0.5"),
        }),
      ),
    );
    unwrap(
      await createTransaction(
        TransactionInput.parse({
          type: "adjustment",
          from: side(card, "GEL", "20"),
        }),
      ),
    );

    expect(await balanceOf(card, "GEL")).toBe("80.5");
  });

  it("keeps 18 decimal places of ETH and 12 integer digits of ARS exact", async () => {
    const vault = await wallet("Сейф", {
      ETH: "0.000000000000000001",
      ARS: "999999999999.99",
    });

    unwrap(
      await createTransaction(income(vault, "ETH", "1.000000000000000001")),
    );
    unwrap(await createTransaction(income(vault, "ARS", "0.01")));

    expect(await balanceOf(vault, "ETH")).toBe("1.000000000000000002");
    expect(await balanceOf(vault, "ARS")).toBe("1000000000000");
  });

  it("rejects an amount finer than the currency allows", async () => {
    const card = await wallet("Карта");

    const cents = await createTransaction(income(card, "USD", "0.001"));
    const satoshi = await createTransaction(
      income(card, "BTC", "0.0000000001"),
    );

    expect(cents).toBeInstanceOf(ValidationError);
    expect(satoshi).toBeInstanceOf(ValidationError);
    expect(await transactionCount()).toBe(0);
  });

  it("rejects a currency outside the catalog", async () => {
    const card = await wallet("Карта");

    expect(await createTransaction(income(card, "XYZ", "1"))).toBeInstanceOf(
      ValidationError,
    );
    expect(
      await createWallet({ name: "Новый", currencies: ["XYZ"] }),
    ).toBeInstanceOf(ValidationError);
    expect(await transactionCount()).toBe(0);
  });

  it("returns NotFoundError for an unknown wallet or category", async () => {
    const card = await wallet("Карта", { ARS: "100" });

    expect(
      await createTransaction(income(crypto.randomUUID(), "ARS", "1")),
    ).toBeInstanceOf(NotFoundError);
    expect(
      await createTransaction(expense(card, "ARS", "1", crypto.randomUUID())),
    ).toBeInstanceOf(NotFoundError);
  });

  it.each([
    ["an expense", "50000", undefined],
    ["a fee", "100", { currency: "ETH", amount: "0.002" }],
  ])(
    "rejects %s beyond the balance and writes nothing (P1, S6)",
    async (_, amount, fee) => {
      const card = await wallet("Карта", { ARS: "12000", ETH: "0.001" });
      const tech = await category("Прочее");
      const before = await transactionCount();

      const result = await createTransaction(
        expense(card, "ARS", amount, tech, fee ? { fee } : {}),
      );

      expect(result).toBeInstanceOf(InsufficientFundsError);
      expect(await transactionCount()).toBe(before);
      expect(await balanceOf(card, "ARS")).toBe("12000");
      expect(await balanceOf(card, "ETH")).toBe("0.001");
    },
  );

  it("names the wallet, the balance and the required amount when money is short", async () => {
    const card = await wallet("Карта", { ARS: "12000" });

    const result = await createTransaction(
      expense(card, "ARS", "50000", await category("Прочее")),
    );

    expect(result).toBeInstanceOf(InsufficientFundsError);
    expect(result).toMatchObject({
      wallet: "Карта",
      currency: "ARS",
      balance: "12000",
      required: "50000",
    });
  });

  it("rejects a transfer and a negative adjustment beyond the balance", async () => {
    const card = await wallet("Карта", { USD: "10" });
    const cash = await wallet("Наличные");

    expect(
      await createTransaction(
        transfer([card, "USD", "11"], [cash, "USD", "11"]),
      ),
    ).toBeInstanceOf(InsufficientFundsError);
    expect(
      await createTransaction(
        TransactionInput.parse({
          type: "adjustment",
          from: side(card, "USD", "10.01"),
        }),
      ),
    ).toBeInstanceOf(InsufficientFundsError);
    expect(await balanceOf(card, "USD")).toBe("10");
    expect(await balanceOf(cash, "USD")).toBeUndefined();
  });

  it("lets the database reject a transfer to the same wallet and currency that skipped the schema", async () => {
    const cash = await wallet("Наличные", { USD: "10" });
    const input: TransactionInput = {
      type: "transfer",
      from: side(cash, "USD", "1"),
      to: side(cash, "USD", "1"),
    };

    const result = await createTransaction(input);

    expect(result).toBeInstanceOf(Error);
    expect(await balanceOf(cash, "USD")).toBe("10");
  });

  it("refuses new transactions in an archived wallet or category but edits old ones (P9)", async () => {
    const card = await wallet("Карта", { ARS: "1000" });
    const old = await category("Старое");
    const kept = unwrap(
      await createTransaction(expense(card, "ARS", "100", old)),
    );
    unwrap(await archiveWallet(card));
    unwrap(await archiveCategory(old));

    expect(await createTransaction(income(card, "ARS", "1"))).toBeInstanceOf(
      ValidationError,
    );
    const active = await wallet("Наличные", { ARS: "1000" });
    expect(
      await createTransaction(expense(active, "ARS", "1", old)),
    ).toBeInstanceOf(ValidationError);

    unwrap(
      await updateTransaction(
        kept.transaction.id,
        expense(card, "ARS", "150", old),
      ),
    );
    expect(await balanceOf(card, "ARS")).toBe("850");
  });
});

describe("updateTransaction", () => {
  it("raises an income 100 → 120 with 10 left, but not below what was spent (P7)", async () => {
    const card = await wallet("Карта");
    const salary = unwrap(await createTransaction(income(card, "USD", "100")));
    unwrap(
      await createTransaction(
        expense(card, "USD", "90", await category("Прочее")),
      ),
    );

    const lower = await updateTransaction(
      salary.transaction.id,
      income(card, "USD", "80"),
    );
    expect(lower).toBeInstanceOf(InsufficientFundsError);
    expect(lower).toMatchObject({ balance: "10", required: "20" });

    const raised = unwrap(
      await updateTransaction(
        salary.transaction.id,
        income(card, "USD", "120"),
      ),
    );
    expect(raised.balances).toEqual([
      { walletId: card, currency: "USD", amount: "30" },
    ]);
    expect(raised.transaction.to?.amount).toBe("120");
  });

  it("replaces the type, the wallets and the amounts", async () => {
    const card = await wallet("Карта", { USD: "100" });
    const cash = await wallet("Наличные", { USD: "50" });
    const spent = unwrap(
      await createTransaction(
        expense(card, "USD", "30", await category("Прочее")),
      ),
    );

    const moved = unwrap(
      await updateTransaction(
        spent.transaction.id,
        transfer([cash, "USD", "20"], [card, "USD", "20"]),
      ),
    );

    expect(moved.transaction).toMatchObject({
      type: "transfer",
      category: null,
    });
    expect(await balanceOf(card, "USD")).toBe("120");
    expect(await balanceOf(cash, "USD")).toBe("30");
  });

  it("keeps the date when the edit leaves occurredAt out", async () => {
    const card = await wallet("Карта");
    const created = unwrap(
      await createTransaction(income(card, "USD", "1", "2026-01-02T03:04:05Z")),
    );

    const edited = unwrap(
      await updateTransaction(
        created.transaction.id,
        TransactionInput.parse({ type: "income", to: side(card, "USD", "2") }),
      ),
    );

    expect(edited.transaction.occurredAt).toEqual(
      new Date("2026-01-02T03:04:05Z"),
    );
  });

  it("refuses to edit a deleted transaction and reports an unknown one", async () => {
    const card = await wallet("Карта");
    const created = unwrap(await createTransaction(income(card, "USD", "1")));
    unwrap(await deleteTransaction(created.transaction.id));

    expect(
      await updateTransaction(created.transaction.id, income(card, "USD", "2")),
    ).toBeInstanceOf(ValidationError);
    expect(
      await updateTransaction(crypto.randomUUID(), income(card, "USD", "2")),
    ).toBeInstanceOf(NotFoundError);
  });
});

describe("deleteTransaction and restoreTransaction", () => {
  it("undoes and repeats the effect (S7)", async () => {
    const cash = await wallet("Наличные", { ARS: "44700" });
    const coffee = unwrap(
      await createTransaction(
        expense(cash, "ARS", "3500", await category("Кафе и рестораны")),
      ),
    );

    const deleted = unwrap(await deleteTransaction(coffee.transaction.id));
    expect(deleted.balances).toEqual([
      { walletId: cash, currency: "ARS", amount: "44700" },
    ]);
    expect(deleted.transaction.deletedAt).toBeInstanceOf(Date);

    const restored = unwrap(await restoreTransaction(coffee.transaction.id));
    expect(restored.balances).toEqual([
      { walletId: cash, currency: "ARS", amount: "41200" },
    ]);
    expect(restored.transaction.deletedAt).toBeNull();
  });

  it("refuses to delete a spent income or restore an expense without money (P8)", async () => {
    const card = await wallet("Карта");
    const other = await category("Прочее");
    const salary = unwrap(await createTransaction(income(card, "USD", "100")));
    const first = unwrap(
      await createTransaction(expense(card, "USD", "90", other)),
    );

    expect(await deleteTransaction(salary.transaction.id)).toBeInstanceOf(
      InsufficientFundsError,
    );

    unwrap(await deleteTransaction(first.transaction.id));
    unwrap(await createTransaction(expense(card, "USD", "100", other)));
    expect(await restoreTransaction(first.transaction.id)).toBeInstanceOf(
      InsufficientFundsError,
    );
    expect(await balanceOf(card, "USD")).toBe("0");
  });

  it("reports a repeated delete, a restore of a live transaction and an unknown id", async () => {
    const card = await wallet("Карта");
    const created = unwrap(await createTransaction(income(card, "USD", "1")));

    expect(await restoreTransaction(created.transaction.id)).toBeInstanceOf(
      ValidationError,
    );
    unwrap(await deleteTransaction(created.transaction.id));
    expect(await deleteTransaction(created.transaction.id)).toBeInstanceOf(
      ValidationError,
    );
    expect(await deleteTransaction(crypto.randomUUID())).toBeInstanceOf(
      NotFoundError,
    );
    expect(await getTransaction(crypto.randomUUID())).toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("wallets, categories and currencies", () => {
  it("creates a wallet with zero balances in the listed currencies", async () => {
    const created = unwrap(
      await createWallet({
        name: " Trust · TRON ",
        note: "TRON",
        currencies: ["USDT", "USDC"],
      }),
    );

    expect(created).toMatchObject({
      name: "Trust · TRON",
      note: "TRON",
      balances: [
        { currency: "USDC", amount: "0" },
        { currency: "USDT", amount: "0" },
      ],
    });
    expect(unwrap(await listWallets())).toEqual([created]);
  });

  it("deletes a wallet without transactions and keeps one with a deleted transaction (P9)", async () => {
    const empty = unwrap(
      await createWallet({ name: "Пустой", currencies: ["USD"] }),
    );
    const used = await wallet("Карта");
    const created = unwrap(await createTransaction(income(used, "USD", "1")));
    unwrap(await deleteTransaction(created.transaction.id));

    expect(await deleteWallet(empty.id)).toBeUndefined();
    expect(await deleteWallet(used)).toBeInstanceOf(ValidationError);
    expect(await deleteWallet(empty.id)).toBeInstanceOf(NotFoundError);
    expect(unwrap(await listWallets()).map((row) => row.id)).toEqual([used]);
  });

  it("keeps active wallet names unique regardless of case and frees an archived name (P10)", async () => {
    const cash = await wallet("Наличные");
    const card = await wallet("Карта");

    expect(await createWallet({ name: "НАЛИЧНЫЕ" })).toBeInstanceOf(
      ValidationError,
    );
    expect(await updateWallet(card, { name: "наличные" })).toBeInstanceOf(
      ValidationError,
    );

    unwrap(await archiveWallet(cash));
    const again = unwrap(await createWallet({ name: "наличные" }));
    expect(unwrap(await listWallets()).map((row) => row.id)).toEqual([
      card,
      again.id,
    ]);
    expect(
      unwrap(await listWallets({ includeArchived: true })).map((row) => row.id),
    ).toEqual([cash, card, again.id]);
  });

  it("renames a wallet and clears its note", async () => {
    const card = unwrap(await createWallet({ name: "Карта", note: "Visa" }));

    expect(
      unwrap(await updateWallet(card.id, { name: "Карта Visa", note: null })),
    ).toMatchObject({ name: "Карта Visa", note: null });
    expect(
      await updateWallet(crypto.randomUUID(), { name: "x" }),
    ).toBeInstanceOf(NotFoundError);
  });

  it("keeps active category names unique regardless of case (P10)", async () => {
    const travel = unwrap(await createCategory("Поездки"));

    expect(await createCategory("продукты")).toBeInstanceOf(ValidationError);
    expect(await renameCategory(travel.id, "ПРОДУКТЫ")).toBeInstanceOf(
      ValidationError,
    );
    expect(
      unwrap(await renameCategory(travel.id, "Поездки за город")).name,
    ).toBe("Поездки за город");

    unwrap(await archiveCategory(travel.id));
    unwrap(await createCategory("поездки за город"));
    expect(
      unwrap(await listCategories()).filter((row) => /поездки/i.test(row.name)),
    ).toHaveLength(1);
  });

  it("adds a currency once and opens its balance in a wallet", async () => {
    const binance = await wallet("Binance");

    unwrap(
      await addCurrency({
        code: "SOL",
        name: "Solana",
        kind: "crypto",
        scale: 9,
        rateId: "solana",
      }),
    );
    expect(
      await addCurrency({
        code: "SOL",
        name: "Solana",
        kind: "crypto",
        scale: 9,
        rateId: "solana",
      }),
    ).toBeInstanceOf(ValidationError);

    expect(unwrap(await addWalletCurrency(binance, "SOL"))).toEqual({
      walletId: binance,
      currency: "SOL",
      amount: "0",
    });
    expect(await addWalletCurrency(binance, "XYZ")).toBeInstanceOf(
      ValidationError,
    );
    expect(await addWalletCurrency(crypto.randomUUID(), "SOL")).toBeInstanceOf(
      NotFoundError,
    );
    unwrap(await createTransaction(income(binance, "SOL", "50.123456789")));
    expect(await balanceOf(binance, "SOL")).toBe("50.123456789");
  });
});

describe("listTransactions", () => {
  it("pages from the newest with a cursor and filters", async () => {
    const card = await wallet("Карта");
    const cash = await wallet("Наличные");
    const food = await category("Продукты");
    const days = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"];
    for (const day of days) {
      unwrap(
        await createTransaction(income(card, "USD", "10", `${day}T10:00:00Z`)),
      );
    }
    unwrap(
      await createTransaction(income(cash, "ARS", "5", "2026-09-05T09:00:00Z")),
    );
    const groceries = unwrap(
      await createTransaction(
        expense(cash, "ARS", "1", food, {
          occurredAt: "2026-09-05T10:00:00Z",
          note: "Молоко и хлеб",
        }),
      ),
    );

    const first = unwrap(await listTransactions({ walletId: card, limit: 3 }));
    expect(
      first.transactions.map((row) =>
        row.occurredAt.toISOString().slice(0, 10),
      ),
    ).toEqual(["2026-09-04", "2026-09-03", "2026-09-02"]);
    const second = unwrap(
      await listTransactions({
        walletId: card,
        limit: 3,
        cursor: first.nextCursor ?? "",
      }),
    );
    expect(
      second.transactions.map((row) =>
        row.occurredAt.toISOString().slice(0, 10),
      ),
    ).toEqual(["2026-09-01"]);
    expect(second.nextCursor).toBeNull();

    const ids = async (
      filter: Partial<Parameters<typeof listTransactions>[0]>,
    ) =>
      unwrap(await listTransactions({ limit: 50, ...filter })).transactions.map(
        (row) => row.id,
      );
    expect(await ids({ type: "expense" })).toEqual([groceries.transaction.id]);
    expect(await ids({ categoryId: food })).toEqual([groceries.transaction.id]);
    expect(await ids({ search: "хлеб" })).toEqual([groceries.transaction.id]);
    expect(await ids({ currency: "ARS" })).toHaveLength(2);
    expect(
      await ids({
        from: new Date("2026-09-02T00:00:00Z"),
        to: new Date("2026-09-04T00:00:00Z"),
      }),
    ).toHaveLength(2);

    unwrap(await deleteTransaction(groceries.transaction.id));
    expect(await ids({ walletId: cash })).toHaveLength(1);
    expect(await ids({ deleted: true })).toEqual([groceries.transaction.id]);
    expect(
      await listTransactions({ limit: 1, cursor: "garbage" }),
    ).toBeInstanceOf(ValidationError);
  });
});

describe("summarize", () => {
  it("sums income, expenses by category and fees without transfers, adjustments and deleted ones (P14, S4)", async () => {
    const cash = await wallet("Наличные", { ARS: "500000", USD: "1000" });
    const binance = await wallet("Binance", { USDT: "100", ETH: "1" });
    const food = await category("Продукты");
    const cafe = await category("Кафе и рестораны");
    const september = "2026-09-10T12:00:00Z";
    for (const [amount, categoryId] of [
      ["100000", food],
      ["80000", food],
      ["96000", cafe],
    ] as const) {
      unwrap(
        await createTransaction(
          expense(cash, "ARS", amount, categoryId, { occurredAt: september }),
        ),
      );
    }
    unwrap(
      await createTransaction(
        expense(cash, "USD", "85", food, {
          occurredAt: september,
          fee: { currency: "USD", amount: "0.5" },
        }),
      ),
    );
    unwrap(
      await createTransaction(
        TransactionInput.parse({
          type: "transfer",
          from: side(binance, "USDT", "50"),
          to: side(cash, "USDT", "50"),
          fee: { currency: "ETH", amount: "0.004" },
          occurredAt: september,
        }),
      ),
    );
    unwrap(
      await createTransaction(
        TransactionInput.parse({
          type: "adjustment",
          from: side(cash, "ARS", "1000"),
          occurredAt: september,
        }),
      ),
    );
    const removed = unwrap(
      await createTransaction(
        expense(cash, "ARS", "7", cafe, { occurredAt: september }),
      ),
    );
    unwrap(await deleteTransaction(removed.transaction.id));
    unwrap(
      await createTransaction(
        expense(cash, "ARS", "9", cafe, { occurredAt: "2026-10-01T00:00:00Z" }),
      ),
    );
    unwrap(await createTransaction(income(cash, "GEL", "20", september)));

    const summary = unwrap(
      await summarize({
        from: new Date("2026-09-01T00:00:00Z"),
        to: new Date("2026-10-01T00:00:00Z"),
      }),
    );

    expect(summary).toEqual({
      income: [{ currency: "GEL", amount: "20" }],
      expenses: [
        {
          categoryId: cafe,
          categoryName: "Кафе и рестораны",
          currency: "ARS",
          amount: "96000",
        },
        {
          categoryId: food,
          categoryName: "Продукты",
          currency: "ARS",
          amount: "180000",
        },
        {
          categoryId: food,
          categoryName: "Продукты",
          currency: "USD",
          amount: "85",
        },
      ],
      fees: [
        { currency: "ETH", amount: "0.004" },
        { currency: "USD", amount: "0.5" },
      ],
    });
    expect(
      unwrap(
        await summarize({
          from: new Date("2026-09-01T00:00:00Z"),
          to: new Date("2026-10-01T00:00:00Z"),
          walletId: binance,
        }),
      ),
    ).toEqual({
      income: [],
      expenses: [],
      fees: [{ currency: "ETH", amount: "0.004" }],
    });
  });
});

describe("summarize in one currency", () => {
  it("converts each amount at the rate of its day and names currencies without a rate (S4, P16)", async () => {
    const cash = await wallet("Наличные", { ARS: "10000", USD: "1000" });
    const food = await category("Продукты");
    for (const [rateCurrency, date, usdPerUnit] of [
      ["ARS", "2026-09-10", "0.001"],
      ["ARS", "2026-09-20", "0.0005"],
      ["USD", "2026-09-01", "1"],
    ] as const) {
      await db.insert(rates).values({
        currency: rateCurrency,
        date,
        usdPerUnit,
        source: "coingecko",
        fetchedAt: new Date(),
      });
    }
    for (const [currency, amount, occurredAt] of [
      ["ARS", "1000", "2026-09-12T12:00:00Z"],
      ["ARS", "1000", "2026-09-25T12:00:00Z"],
      ["ARS", "500", "2026-09-05T12:00:00Z"],
    ] as const) {
      unwrap(
        await createTransaction(
          expense(cash, currency, amount, food, { occurredAt }),
        ),
      );
    }
    unwrap(
      await createTransaction(
        expense(cash, "USD", "85", food, {
          occurredAt: "2026-09-12T12:00:00Z",
          fee: { currency: "USD", amount: "0.5" },
        }),
      ),
    );
    unwrap(await createTransaction(income(cash, "GEL", "20")));
    const september = {
      from: new Date("2026-09-01T00:00:00Z"),
      to: new Date("2026-10-01T00:00:00Z"),
    };

    const summary = unwrap(
      await summarize({ ...september, inCurrency: "USD" }),
    );

    expect(summary.inCurrency).toEqual({
      currency: "USD",
      income: "0",
      expenses: "87",
      fees: "0.5",
      approximate: true,
      missing: ["GEL"],
    });
    expect(await summarize({ ...september, inCurrency: "XYZ" })).toBeInstanceOf(
      ValidationError,
    );
    expect(unwrap(await summarize(september)).inCurrency).toBeUndefined();
  });
});

describe("concurrency", () => {
  it("lets exactly 15 of 20 parallel expenses of 10 through a balance of 150", async () => {
    const card = await wallet("Карта", { USD: "150" });
    const other = await category("Прочее");

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        createTransaction(expense(card, "USD", "10", other)),
      ),
    );

    expect(results.filter((result) => !(result instanceof Error))).toHaveLength(
      15,
    );
    expect(
      results.filter((result) => result instanceof InsufficientFundsError),
    ).toHaveLength(5);
    expect(await balanceOf(card, "USD")).toBe("0");
  });

  it("runs opposite transfers at once without a deadlock", async () => {
    const a = await wallet("A", { USD: "1000" });
    const b = await wallet("B", { USD: "1000" });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => [
        createTransaction(transfer([a, "USD", "1"], [b, "USD", "1"])),
        createTransaction(transfer([b, "USD", "1"], [a, "USD", "1"])),
      ]).flat(),
    );

    expect(results.filter((result) => result instanceof Error)).toEqual([]);
    expect(await balanceOf(a, "USD")).toBe("1000");
    expect(await balanceOf(b, "USD")).toBe("1000");
  });

  it("applies the effect once when one transaction is deleted twice at once", async () => {
    const card = await wallet("Карта", { USD: "100" });
    const spent = unwrap(
      await createTransaction(
        expense(card, "USD", "40", await category("Прочее")),
      ),
    );

    const results = await Promise.all([
      deleteTransaction(spent.transaction.id),
      deleteTransaction(spent.transaction.id),
    ]);

    expect(results.filter((result) => !(result instanceof Error))).toHaveLength(
      1,
    );
    expect(
      results.filter((result) => result instanceof ValidationError),
    ).toHaveLength(1);
    expect(await balanceOf(card, "USD")).toBe("100");
  });

  it("serializes two edits of one transaction", async () => {
    const card = await wallet("Карта");
    const salary = unwrap(await createTransaction(income(card, "USD", "100")));

    const results = await Promise.all([
      updateTransaction(salary.transaction.id, income(card, "USD", "150")),
      updateTransaction(salary.transaction.id, income(card, "USD", "200")),
    ]);

    expect(results.filter((result) => result instanceof Error)).toEqual([]);
    const saved = unwrap(await getTransaction(salary.transaction.id));
    expect(await balanceOf(card, "USD")).toBe(saved.to?.amount);
  });
});
