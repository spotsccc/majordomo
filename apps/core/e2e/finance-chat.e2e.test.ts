import { balances, rates, transactions, wallets } from "@repo/db";
import { unwrap } from "@spotsccc/error-as-value";
import {
  CODEX_URL,
  codexAnswer,
  codexToolCall,
  signIn,
} from "@/lib/chatgpt.test-utils";
import { db } from "@/lib/db";
import {
  createTransaction,
  createWallet,
  listCategories,
  listTransactions,
  listWallets,
} from "@/lib/finance/finance-store";
import { TransactionInput } from "@/lib/finance/money";
import { expect, test } from "./fixtures";

test("the owner records an expense by a chat message and sees the new balance (S1)", async ({
  ownerPage: page,
  openai,
}) => {
  await db.delete(rates);
  await db.delete(transactions);
  await db.delete(balances);
  await db.delete(wallets);
  const cash = unwrap(await createWallet({ name: "Наличные" })).id;
  unwrap(
    await createTransaction(
      TransactionInput.parse({
        type: "income",
        to: { walletId: cash, currency: "ARS", amount: "44700" },
      }),
    ),
  );
  const cafe = unwrap(await listCategories()).find(
    (category) => category.name === "Кафе и рестораны",
  );
  await signIn();
  const steps = [
    () => codexToolCall("list_wallets", {}),
    () =>
      codexToolCall("create_transaction", {
        transaction: {
          type: "expense",
          from: { walletId: cash, currency: "ARS", amount: "3500" },
          categoryId: cafe?.id,
          note: "кофе",
        },
      }),
    () =>
      codexAnswer(
        "Записал: 3 500 ARS, Кафе и рестораны. Остаток Наличные — 41 200 ARS.",
      ),
  ];
  let step = 0;
  openai.on(`POST ${CODEX_URL}`, () => {
    const answer = steps[step++];
    if (!answer) throw new Error(`Лишний запрос к модели №${step}`);
    return answer();
  });

  await page.goto("/");
  await page
    .getByPlaceholder("Сообщение")
    .fill("потратил 3500 песо на кофе с наличных");
  await page.getByRole("button", { name: "Отправить" }).click();

  await expect(page.getByText(/Остаток Наличные — 41 200 ARS/)).toBeVisible();
  await expect(page.getByText("Записано")).toBeVisible();
  expect(
    unwrap(await listTransactions({ type: "expense", limit: 10 })).transactions,
  ).toMatchObject([
    {
      from: { walletId: cash, currency: "ARS", amount: "3500" },
      category: { name: "Кафе и рестораны" },
      note: "кофе",
    },
  ]);
  expect(
    unwrap(await listWallets())
      .find((wallet) => wallet.id === cash)
      ?.balances.find((balance) => balance.currency === "ARS")?.amount,
  ).toBe("41200");
  expect(openai.requests).toHaveLength(3);
  expect(openai.requests[2]?.body).toContain("function_call_output");
});
