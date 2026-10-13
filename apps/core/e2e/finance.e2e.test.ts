import { randomUUID } from "node:crypto";
import { balances, currencies, rates, transactions, wallets } from "@repo/db";
import { unwrap } from "@spotsccc/error-as-value";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  createTransaction,
  createWallet,
  getTransaction,
  listCategories,
  listTransactions,
  listWallets,
} from "@/lib/finance/finance-store";
import { balanceMismatches } from "@/lib/finance/finance.test-utils";
import { TransactionInput } from "@/lib/finance/money";
import { expect, test } from "./fixtures";

async function balanceOf(name: string, currency: string) {
  const wallet = unwrap(await listWallets()).find((item) => item.name === name);
  return wallet?.balances.find((item) => item.currency === currency)?.amount;
}

test.beforeEach(async () => {
  await db.delete(rates);
  await db.delete(transactions);
  await db.delete(balances);
  await db.delete(wallets);
  await db.delete(currencies).where(eq(currencies.code, "BRL"));
});

test("the owner keeps the books in the browser from a new wallet to a restored expense", async ({
  ownerPage: page,
}) => {
  const today = new Date().toISOString().slice(0, 10);
  const fetchedAt = new Date();
  await db.insert(rates).values([
    {
      currency: "USD",
      date: today,
      usdPerUnit: "1",
      source: "coingecko",
      fetchedAt,
    },
    {
      currency: "ARS",
      date: today,
      usdPerUnit: "0.001",
      source: "coingecko",
      fetchedAt,
    },
  ]);

  await page.goto("/finance/wallets/new");
  await page.getByLabel("Имя").fill("Наличные");
  await page
    .getByLabel("Начальный остаток ARS", { exact: true })
    .fill("44 700");
  await page.getByRole("button", { name: "Создать кошелёк" }).click();
  await expect(page.getByRole("heading", { name: "Наличные" })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Остатки" }).getByText(/^44\s700\sARS$/),
  ).toBeVisible();

  await page.goto("/finance/wallets/new");
  await page.getByLabel("Имя").fill("Карта");
  await page.getByRole("checkbox", { name: "USD Доллар США" }).check();
  await page.getByLabel("Начальный остаток USD", { exact: true }).fill("500");
  await page.getByRole("button", { name: "Создать кошелёк" }).click();
  await expect(page.getByRole("heading", { name: "Карта" })).toBeVisible();

  await page.goto("/finance/transactions/new");
  await page.getByLabel("Кошелёк", { exact: true }).selectOption("Наличные");
  await page.getByLabel("Сумма", { exact: true }).fill("3 500");
  await page.getByRole("button", { name: "Записать" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Выберите категорию" }),
  ).toBeVisible();
  await page.getByLabel("Категория").selectOption("+ Новая категория");
  await page.getByLabel("Имя новой категории").fill("Кофейни");
  await page.getByLabel("Заметка").fill("кофе");
  await page.getByRole("button", { name: "Записать" }).click();
  await expect(page).toHaveURL(/\/finance\/transactions\/[0-9a-f-]{36}$/);
  const expenseId = page.url().split("/").at(-1) ?? "";
  expect(unwrap(await getTransaction(expenseId))).toMatchObject({
    type: "expense",
    from: { currency: "ARS", amount: "3500", walletName: "Наличные" },
    category: { name: "Кофейни" },
    note: "кофе",
  });

  await page.goto("/finance/transactions/new");
  await page.getByLabel("Кошелёк", { exact: true }).selectOption("Наличные");
  await page.getByLabel("Сумма", { exact: true }).fill("50000");
  await page.getByLabel("Категория").selectOption("Кофейни");
  await page.getByRole("button", { name: "Записать" }).click();
  await expect(
    page.getByText(
      /Недостаточно средств: в «Наличные» 41\s200\sARS, а нужно 50\s000\sARS/,
    ),
  ).toBeVisible();
  await expect(page.getByLabel("Сумма", { exact: true })).toHaveValue("50000");
  expect(
    unwrap(await listTransactions({ type: "expense", limit: 10 })).transactions,
  ).toHaveLength(1);

  await page.getByRole("button", { name: "Перевод" }).click();
  await page.getByLabel("Откуда").selectOption("Карта");
  await page.getByLabel("Валюта", { exact: true }).selectOption("USD");
  await page.getByLabel("Сумма", { exact: true }).fill("100");
  await page.getByLabel("Куда", { exact: true }).selectOption("Наличные");
  await page.getByLabel("Валюта зачисления").selectOption("ARS");
  await page.getByLabel("Сумма зачисления").fill("151 000");
  await expect(page.getByText(/Курс: 1 USD = 1\s?510 ARS/)).toBeVisible();
  await page.getByRole("button", { name: "Записать" }).click();
  await expect(page).toHaveURL(/\/finance\/transactions\/[0-9a-f-]{36}$/);

  await page.goto("/finance");
  await expect(page.getByText(/≈ 592,20\sUSD/)).toBeVisible();
  await expect(page.getByText(/192\s200\sARS/)).toBeVisible();
  await expect(page.getByText(/^400\sUSD$/)).toBeVisible();
  expect(await balanceOf("Наличные", "ARS")).toBe("192200");
  expect(await balanceOf("Карта", "USD")).toBe("400");
  expect(await balanceMismatches()).toEqual([]);

  await page
    .getByRole("combobox", { name: "Валюта итога" })
    .selectOption("ARS");
  await page.getByRole("button", { name: "Показать" }).click();
  await expect(page).toHaveURL("/finance?in=ARS");
  await expect(page.getByText(/≈ 592\s200\sARS/)).toBeVisible();

  await page.goto(`/finance/transactions/${expenseId}`);
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Удалить" }).click();
  await expect(page.getByText("· удалена")).toBeVisible();
  expect(unwrap(await getTransaction(expenseId)).deletedAt).not.toBeNull();
  expect(await balanceOf("Наличные", "ARS")).toBe("195700");

  await page.getByRole("button", { name: "Восстановить" }).click();
  await expect(page.getByRole("button", { name: "Сохранить" })).toBeVisible();
  expect(unwrap(await getTransaction(expenseId)).deletedAt).toBeNull();
  expect(await balanceOf("Наличные", "ARS")).toBe("192200");
  expect(await balanceMismatches()).toEqual([]);
});

test("the owner edits an expense: an untouched date stays to the millisecond, a new one is the owner's wall time", async ({
  ownerPage: page,
}) => {
  const cash = unwrap(await createWallet({ name: "Наличные" })).id;
  unwrap(
    await createTransaction(
      TransactionInput.parse({
        type: "income",
        to: { walletId: cash, currency: "ARS", amount: "1000" },
      }),
    ),
  );
  const cafe = unwrap(await listCategories()).find(
    (category) => category.name === "Кафе и рестораны",
  );
  const { transaction } = unwrap(
    await createTransaction(
      TransactionInput.parse({
        type: "expense",
        from: { walletId: cash, currency: "ARS", amount: "100" },
        categoryId: cafe?.id,
        occurredAt: "2026-10-01T09:15:30.500Z",
      }),
    ),
  );

  await page.goto(`/finance/transactions/${transaction.id}`);
  await expect(page.getByLabel("Когда")).toHaveValue("2026-10-01T09:15");
  await page.getByLabel("Сумма", { exact: true }).fill("120");
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect
    .poll(async () => unwrap(await getTransaction(transaction.id)).from?.amount)
    .toBe("120");
  expect(unwrap(await getTransaction(transaction.id)).occurredAt).toEqual(
    new Date("2026-10-01T09:15:30.500Z"),
  );
  expect(await balanceOf("Наличные", "ARS")).toBe("880");

  await page.getByLabel("Когда").fill("2026-09-30T10:00");
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect
    .poll(async () => unwrap(await getTransaction(transaction.id)).occurredAt)
    .toEqual(new Date("2026-09-30T10:00:00Z"));
});

test("the owner adds a fiat currency and renames and archives a category", async ({
  ownerPage: page,
}) => {
  await page.goto("/finance/currencies");
  await page.getByLabel("Код ISO 4217").fill("BRL");
  await page.getByLabel("Название", { exact: true }).fill("Бразильский реал");
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "Бразильский реал" }),
  ).toBeVisible();

  await page.getByLabel("Код ISO 4217").fill("BRL");
  await page.getByLabel("Название", { exact: true }).fill("Реал");
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await expect(page.getByText("Такая валюта уже есть.")).toBeVisible();

  const name = `Хобби ${randomUUID().slice(0, 8)}`;
  await page.goto("/finance/categories");
  await page.getByPlaceholder("Новая категория").fill(name);
  await page.getByRole("button", { name: "Создать" }).click();
  await page.getByLabel(`Имя категории ${name}`).fill(`${name} и спорт`);
  await page
    .getByRole("row", { name: new RegExp(name) })
    .getByRole("button", { name: "Переименовать" })
    .click();
  await expect(page.getByLabel(`Имя категории ${name} и спорт`)).toBeVisible();
  await page.getByRole("button", { name: `В архив: ${name} и спорт` }).click();
  await expect(page.getByLabel(`Имя категории ${name} и спорт`)).toBeHidden();
  await expect(page.getByText(`${name} и спорт`)).toBeAttached();
});

test("a missing or malformed transaction id is a 404", async ({
  ownerPage: page,
}) => {
  const missing = await page.goto(`/finance/transactions/${randomUUID()}`);
  expect(missing?.status()).toBe(404);
  const malformed = await page.goto("/finance/transactions/abc");
  expect(malformed?.status()).toBe(404);
  const wallet = await page.goto(`/finance/wallets/${randomUUID()}`);
  expect(wallet?.status()).toBe(404);
});
