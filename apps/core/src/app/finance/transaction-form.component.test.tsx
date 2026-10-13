import { beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  TransactionForm,
  type FormState,
  type FormValues,
} from "./transaction-form";

const CASH = "00000000-0000-4000-8000-000000000001";
const CARD = "00000000-0000-4000-8000-000000000002";
const TECH = "00000000-0000-4000-8000-000000000003";

const WALLETS = [
  {
    id: CASH,
    name: "Наличные",
    archived: false,
    balances: [
      { currency: "ARS", amount: "41200" },
      { currency: "USD", amount: "500" },
    ],
  },
  {
    id: CARD,
    name: "Карта",
    archived: false,
    balances: [{ currency: "ARS", amount: "12000" }],
  },
];

const CURRENCIES = [
  { code: "ARS", name: "Аргентинское песо", kind: "fiat" as const, scale: 2 },
  { code: "USD", name: "Доллар США", kind: "fiat" as const, scale: 2 },
  { code: "ETH", name: "Ethereum", kind: "crypto" as const, scale: 18 },
];

const INITIAL: FormValues = {
  type: "expense",
  wallet: CARD,
  currency: "ARS",
  amount: "",
  toWallet: CASH,
  toCurrency: "ARS",
  toAmount: "",
  feeCurrency: "ARS",
  feeAmount: "",
  category: "",
  newCategory: "",
  direction: "in",
  occurredAt: "2026-10-12T14:02",
  note: "",
};

function renderForm(
  answer: (formData: FormData) => FormState = () => null,
  initial: FormValues = INITIAL,
) {
  const sent: Record<string, string>[] = [];
  const action = async (_state: FormState, formData: FormData) => {
    sent.push(
      Object.fromEntries(
        [...formData.entries()].map(([key, value]) => [key, String(value)]),
      ),
    );
    return answer(formData);
  };
  return {
    sent,
    screen: render(
      <TransactionForm
        action={action}
        initial={initial}
        wallets={WALLETS}
        categories={[{ id: TECH, name: "Техника" }]}
        currencies={CURRENCIES}
        submitLabel="Записать"
      />,
    ),
  };
}

describe("TransactionForm", () => {
  /** The pointer is moved to the corner, so it cannot hover a button and change a screenshot. */
  beforeEach(async () => {
    await page
      .elementLocator(document.documentElement)
      .hover({ position: { x: 0, y: 0 } });
  });

  it("shows the fields of each transaction type", async () => {
    const { screen } = renderForm();
    const view = await screen;

    await expect.element(view.getByLabelText("Категория")).toBeVisible();
    await expect
      .element(view.getByLabelText("Комиссия (необязательно)"))
      .toBeVisible();

    await view.getByRole("button", { name: "Пополнение" }).click();
    await expect
      .element(view.getByLabelText("Категория"))
      .not.toBeInTheDocument();
    await expect
      .element(view.getByLabelText("Комиссия (необязательно)"))
      .not.toBeInTheDocument();

    await view.getByRole("button", { name: "Перевод" }).click();
    await expect.element(view.getByLabelText("Куда")).toBeVisible();
    await expect
      .element(view.getByLabelText("Комиссия (необязательно)"))
      .toBeVisible();

    await view.getByRole("button", { name: "Корректировка" }).click();
    await expect.element(view.getByLabelText("Направление")).toBeVisible();
    await expect.element(view.getByLabelText("Куда")).not.toBeInTheDocument();
  });

  it("normalizes «3 500,50» to 3500.50 and sends the expense with its fee and a new category", async () => {
    const { screen, sent } = renderForm();
    const view = await screen;

    await view.getByLabelText("Сумма", { exact: true }).fill("3 500,50");
    await view.getByLabelText("Заметка").click();
    await expect
      .element(view.getByLabelText("Сумма", { exact: true }))
      .toHaveValue("3500.50");
    await view.getByLabelText("Категория").selectOptions("+ Новая категория");
    await view.getByLabelText("Имя новой категории").fill("Подарки");
    await view.getByLabelText("Комиссия (необязательно)").fill("0,0012");
    await view.getByLabelText("Валюта комиссии").selectOptions("ETH");
    await view.getByRole("button", { name: "Записать" }).click();

    await expect.poll(() => sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "expense",
      wallet: CARD,
      currency: "ARS",
      amount: "3500.50",
      category: "new",
      newCategory: "Подарки",
      feeAmount: "0.0012",
      feeCurrency: "ETH",
      occurredAt: "2026-10-12T14:02",
      occurredAtInitial: "2026-10-12T14:02",
    });
  });

  it("keeps the amount and shows the insufficient funds error next to it", async () => {
    const { screen } = renderForm(() => ({
      field: "amount",
      message: "Недостаточно средств: в «Карта» 12 000 ARS, а нужно 50 000 ARS",
    }));
    const view = await screen;

    await view.getByLabelText("Сумма", { exact: true }).fill("50000");
    await view.getByLabelText("Категория").selectOptions("Техника");
    await view.getByRole("button", { name: "Записать" }).click();

    await expect
      .element(view.getByText(/в «Карта» 12 000 ARS, а нужно 50 000 ARS/))
      .toBeVisible();
    await expect
      .element(view.getByLabelText("Сумма", { exact: true }))
      .toHaveValue("50000");
    await expect
      .element(view.getByLabelText("Сумма", { exact: true }))
      .toHaveAttribute("aria-invalid", "true");
    await expect
      .element(page.elementLocator(view.container))
      .toMatchScreenshot("insufficient-funds");
  });

  it("forbids a transfer to the same wallet and currency and shows the rate of an exchange", async () => {
    const { screen, sent } = renderForm(() => null, {
      ...INITIAL,
      type: "transfer",
      wallet: CASH,
      currency: "USD",
      toWallet: CASH,
      toCurrency: "USD",
      feeCurrency: "USD",
    });
    const view = await screen;

    await expect
      .element(view.getByText(/в тот же кошелёк и ту же валюту/))
      .toBeVisible();
    await expect
      .element(view.getByRole("button", { name: "Записать" }))
      .toBeDisabled();

    await view.getByLabelText("Валюта зачисления").selectOptions("ARS");
    await view.getByLabelText("Сумма", { exact: true }).fill("100");
    await view.getByLabelText("Сумма зачисления").fill("151 000");
    await view.getByLabelText("Заметка").click();

    await expect.element(view.getByRole("alert")).not.toBeInTheDocument();
    await expect
      .element(view.getByText(/^Курс: 1 USD = 1\s?510 ARS$/))
      .toBeVisible();
    await expect.element(view.getByText(/^Остаток: 500/)).toBeVisible();
    await expect
      .element(page.elementLocator(view.container))
      .toMatchScreenshot("exchange");

    await view.getByRole("button", { name: "Записать" }).click();
    await expect.poll(() => sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "transfer",
      wallet: CASH,
      currency: "USD",
      amount: "100",
      toWallet: CASH,
      toCurrency: "ARS",
      toAmount: "151000",
    });
  });
});
