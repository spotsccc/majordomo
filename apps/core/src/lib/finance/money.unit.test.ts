import { describe, expect, it } from "vitest";
import {
  Amount,
  formatAmount,
  NewCurrency,
  normalizeAmount,
  TransactionInput,
} from "./money";

const WALLET = "00000000-0000-4000-8000-000000000001";
const OTHER_WALLET = "00000000-0000-4000-8000-000000000002";
const CATEGORY = "00000000-0000-4000-8000-000000000003";

describe("normalizeAmount", () => {
  it.each([
    ["3 500,50", "3500.50"],
    ["3\u00a0500,50", "3500.50"],
    ["1\u202f500", "1500"],
    ["1,500.50", "1500.50"],
    [" 0,0012 ", "0.0012"],
    ["3500.50", "3500.50"],
    ["abc", "abc"],
  ])("turns %j into %j", (input, output) => {
    expect(normalizeAmount(input)).toBe(output);
  });
});

describe("Amount", () => {
  it.each([
    ["0.1", "0.1"],
    ["3500", "3500"],
    ["3500.50", "3500.5"],
    ["1.000", "1"],
    ["1.0000000000000000000", "1"],
    ["0.000000000000000001", "0.000000000000000001"],
    [
      "12345678901234567890.123456789012345678",
      "12345678901234567890.123456789012345678",
    ],
  ])("accepts %s as %s", (input, output) => {
    expect(Amount.parse(input)).toBe(output);
  });

  it.each([
    ["1e5"],
    ["-1"],
    ["0"],
    ["0.000"],
    ["0.1234567890123456789"],
    ["123456789012345678901"],
    ["3 500,50"],
    ["3500,50"],
    ["007"],
    [".5"],
    [""],
  ])("rejects %j", (input) => {
    expect(Amount.safeParse(input).success).toBe(false);
  });

  it("rejects a number", () => {
    expect(Amount.safeParse(1500).success).toBe(false);
  });
});

describe("TransactionInput", () => {
  it("parses every type and turns occurredAt into a Date", () => {
    expect(
      TransactionInput.parse({
        type: "expense",
        from: { walletId: WALLET, currency: "ARS", amount: "3500.00" },
        categoryId: CATEGORY,
        fee: { currency: "ARS", amount: "10" },
        occurredAt: "2026-09-30T22:00:00-03:00",
        note: "  кофе ",
      }),
    ).toEqual({
      type: "expense",
      from: { walletId: WALLET, currency: "ARS", amount: "3500" },
      categoryId: CATEGORY,
      fee: { currency: "ARS", amount: "10" },
      occurredAt: new Date("2026-10-01T01:00:00Z"),
      note: "кофе",
    });
    for (const input of [
      {
        type: "income",
        to: { walletId: WALLET, currency: "USD", amount: "1" },
      },
      {
        type: "transfer",
        from: { walletId: WALLET, currency: "USD", amount: "100" },
        to: { walletId: WALLET, currency: "ARS", amount: "151000" },
      },
      {
        type: "adjustment",
        from: { walletId: WALLET, currency: "USD", amount: "1" },
      },
      {
        type: "adjustment",
        to: { walletId: WALLET, currency: "USD", amount: "1" },
      },
    ]) {
      expect(TransactionInput.safeParse(input).success).toBe(true);
    }
  });

  it.each([
    [
      "an extra field",
      {
        type: "income",
        to: { walletId: WALLET, currency: "USD", amount: "1" },
        categoryId: CATEGORY,
      },
    ],
    [
      "a fee on income",
      {
        type: "income",
        to: { walletId: WALLET, currency: "USD", amount: "1" },
        fee: { currency: "USD", amount: "1" },
      },
    ],
    [
      "an amount as a number",
      { type: "income", to: { walletId: WALLET, currency: "USD", amount: 1 } },
    ],
    [
      "an amount with a comma",
      {
        type: "income",
        to: { walletId: WALLET, currency: "ARS", amount: "1 500,50" },
      },
    ],
    [
      "a lowercase currency",
      {
        type: "income",
        to: { walletId: WALLET, currency: "usd", amount: "1" },
      },
    ],
    [
      "an expense without a category",
      {
        type: "expense",
        from: { walletId: WALLET, currency: "USD", amount: "1" },
      },
    ],
    [
      "a transfer to the same wallet and currency",
      {
        type: "transfer",
        from: { walletId: WALLET, currency: "USD", amount: "1" },
        to: { walletId: WALLET, currency: "USD", amount: "1" },
      },
    ],
    [
      "a transfer in one currency with different amounts",
      {
        type: "transfer",
        from: { walletId: WALLET, currency: "USDT", amount: "100" },
        to: { walletId: OTHER_WALLET, currency: "USDT", amount: "99" },
      },
    ],
    [
      "an adjustment with both sides",
      {
        type: "adjustment",
        from: { walletId: WALLET, currency: "USD", amount: "1" },
        to: { walletId: OTHER_WALLET, currency: "USD", amount: "1" },
      },
    ],
    ["an adjustment without sides", { type: "adjustment" }],
    [
      "a date without an offset",
      {
        type: "income",
        to: { walletId: WALLET, currency: "USD", amount: "1" },
        occurredAt: "2026-09-30T22:00:00",
      },
    ],
  ])("rejects %s", (_, input) => {
    expect(TransactionInput.safeParse(input).success).toBe(false);
  });
});

describe("NewCurrency", () => {
  it.each([
    ["SOL", "crypto", 9, "solana", true],
    ["USDE", "crypto", 18, "ethena-usde", true],
    ["GEL", "fiat", 2, undefined, true],
    ["USDE", "fiat", 2, undefined, false],
    ["SOL", "crypto", 9, undefined, false],
    ["EUR", "fiat", 2, "euro", false],
    ["SOL", "crypto", 19, "solana", false],
  ] as const)(
    "takes %s as %s with scale %i and coin %s: %s",
    (code, kind, scale, rateId, valid) => {
      expect(
        NewCurrency.safeParse({ code, name: code, kind, scale, rateId })
          .success,
      ).toBe(valid);
    },
  );
});

describe("formatAmount", () => {
  const nbsp = (text: string) => text.replaceAll(" ", " ");
  const GEL = { code: "GEL", kind: "fiat", scale: 2 } as const;
  const ARS = { code: "ARS", kind: "fiat", scale: 2 } as const;
  const ETH = { code: "ETH", kind: "crypto", scale: 18 } as const;

  it("shows fiat with kopecks only when they are there", () => {
    expect(formatAmount("1500.5", GEL)).toBe(nbsp("1 500,50 GEL"));
    expect(formatAmount("3500", ARS)).toBe(nbsp("3 500 ARS"));
  });

  it("shows crypto with every significant digit and without trailing zeros", () => {
    expect(formatAmount("0.0988", ETH)).toBe(nbsp("0,0988 ETH"));
    expect(formatAmount("0.098800000000000000", ETH)).toBe(nbsp("0,0988 ETH"));
    expect(formatAmount("12345678901234567890.123456789012345678", ETH)).toBe(
      nbsp("12 345 678 901 234 567 890,123456789012345678 ETH"),
    );
  });
});
