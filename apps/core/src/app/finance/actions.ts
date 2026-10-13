"use server";

import { NotFoundError, ValidationError } from "@repo/errors";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { requireOwnerSession } from "@/lib/auth";
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
  InsufficientFundsError,
  listCategories,
  listCurrencies,
  renameCategory,
  restoreTransaction,
  updateTransaction,
  updateWallet,
  type Written,
} from "@/lib/finance/finance-store";
import {
  Amount,
  fractionDigits,
  NewCurrency,
  normalizeAmount,
  TransactionInput,
} from "@/lib/finance/money";
import { fromOwnerDateTime } from "@/lib/owner-time";
import type { FormErrorCode } from "./form-errors";
import { money } from "./format";
import type { FormField, FormState } from "./transaction-form";

const Text = z.string().trim();

const TransactionForm = z.object({
  type: z.enum(["income", "expense", "transfer", "adjustment"]),
  wallet: Text,
  currency: Text,
  amount: Text,
  toWallet: Text.default(""),
  toCurrency: Text.default(""),
  toAmount: Text.default(""),
  feeCurrency: Text.default(""),
  feeAmount: Text.default(""),
  category: Text.default(""),
  newCategory: Text.default(""),
  direction: z.enum(["in", "out"]).default("in"),
  occurredAt: Text,
  occurredAtInitial: Text.default(""),
  note: Text.default(""),
});

type TransactionForm = z.output<typeof TransactionForm>;

type Failure = NonNullable<FormState>;

const DATE_TIME_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export async function createTransactionAction(
  _state: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireOwnerSession();
  const input = await transactionInput(formData);
  if ("message" in input) return input;
  return finishTransaction(await createTransaction(input.value), input.form);
}

export async function updateTransactionAction(
  id: string,
  _state: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireOwnerSession();
  const input = await transactionInput(formData);
  if ("message" in input) return input;
  return finishTransaction(
    await updateTransaction(id, input.value),
    input.form,
  );
}

export async function deleteTransactionAction(id: string): Promise<void> {
  await requireOwnerSession();
  const deleted = await deleteTransaction(id);
  if (deleted instanceof Error) {
    fail(`/finance/transactions/${id}`, deleted, "state");
  }
  done(`/finance/transactions/${id}`);
}

export async function restoreTransactionAction(id: string): Promise<void> {
  await requireOwnerSession();
  const restored = await restoreTransaction(id);
  if (restored instanceof Error) {
    fail(`/finance/transactions/${id}`, restored, "state");
  }
  done(`/finance/transactions/${id}`);
}

/** Every amount is checked before the wallet is written, so a resubmitted form does not meet its own wallet name. */
export async function createWalletAction(formData: FormData): Promise<void> {
  await requireOwnerSession();
  const back = "/finance/wallets/new";
  const name = text(formData, "name");
  const note = text(formData, "note");
  if (!name) redirect(`${back}?error=name`);

  const currencies = await listCurrencies();
  if (currencies instanceof Error) fail(back, currencies, "internal");
  const chosen: string[] = [];
  const opening: { currency: string; amount: string }[] = [];
  for (const currency of currencies) {
    const typed = normalizeAmount(text(formData, `opening.${currency.code}`));
    const zero = /^0*\.?0*$/.test(typed);
    if (!formData.has(`currency.${currency.code}`) && zero) continue;
    chosen.push(currency.code);
    if (zero) continue;
    const amount = Amount.safeParse(typed);
    if (!amount.success || fractionDigits(amount.data) > currency.scale) {
      redirect(`${back}?error=amount`);
    }
    opening.push({ currency: currency.code, amount: amount.data });
  }

  const wallet = await createWallet({
    name,
    note: note || undefined,
    currencies: chosen,
  });
  if (wallet instanceof Error) fail(back, wallet, "name-taken");
  for (const side of opening) {
    const written = await createTransaction({
      type: "adjustment",
      to: { walletId: wallet.id, ...side },
      note: "Начальный остаток",
    });
    if (written instanceof Error) {
      fail(`/finance/wallets/${wallet.id}`, written, "internal");
    }
  }
  done(`/finance/wallets/${wallet.id}`);
}

export async function updateWalletAction(
  id: string,
  formData: FormData,
): Promise<void> {
  await requireOwnerSession();
  const back = `/finance/wallets/${id}`;
  const name = text(formData, "name");
  const note = text(formData, "note");
  if (!name) redirect(`${back}?error=name`);
  const wallet = await updateWallet(id, { name, note: note || null });
  if (wallet instanceof Error) fail(back, wallet, "name-taken");
  done(back);
}

export async function archiveWalletAction(id: string): Promise<void> {
  await requireOwnerSession();
  const wallet = await archiveWallet(id);
  if (wallet instanceof Error)
    fail(`/finance/wallets/${id}`, wallet, "internal");
  done(`/finance/wallets/${id}`);
}

export async function deleteWalletAction(id: string): Promise<void> {
  await requireOwnerSession();
  const deleted = await deleteWallet(id);
  if (deleted instanceof Error) {
    fail(`/finance/wallets/${id}`, deleted, "wallet-used");
  }
  done("/finance");
}

export async function addWalletCurrencyAction(
  id: string,
  formData: FormData,
): Promise<void> {
  await requireOwnerSession();
  const back = `/finance/wallets/${id}`;
  const balance = await addWalletCurrency(id, text(formData, "currency"));
  if (balance instanceof Error) fail(back, balance, "currency");
  done(back);
}

export async function createCategoryAction(formData: FormData): Promise<void> {
  await requireOwnerSession();
  const back = "/finance/categories";
  const name = text(formData, "name");
  if (!name) redirect(`${back}?error=name`);
  const category = await createCategory(name);
  if (category instanceof Error) fail(back, category, "name-taken");
  done(back);
}

export async function renameCategoryAction(
  id: string,
  formData: FormData,
): Promise<void> {
  await requireOwnerSession();
  const back = "/finance/categories";
  const name = text(formData, "name");
  if (!name) redirect(`${back}?error=name`);
  const category = await renameCategory(id, name);
  if (category instanceof Error) fail(back, category, "name-taken");
  done(back);
}

export async function archiveCategoryAction(id: string): Promise<void> {
  await requireOwnerSession();
  const category = await archiveCategory(id);
  if (category instanceof Error) {
    fail("/finance/categories", category, "internal");
  }
  done("/finance/categories");
}

export async function addCurrencyAction(formData: FormData): Promise<void> {
  await requireOwnerSession();
  const back = "/finance/currencies";
  const rateId = text(formData, "rateId");
  const parsed = NewCurrency.safeParse({
    code: text(formData, "code").toUpperCase(),
    name: text(formData, "name"),
    kind: text(formData, "kind"),
    scale: Number(formData.get("scale")),
    rateId: rateId || undefined,
  });
  if (!parsed.success) redirect(`${back}?error=currency`);
  const currency = await addCurrency(parsed.data);
  if (currency instanceof Error) fail(back, currency, "currency-taken");
  done(back);
}

async function transactionInput(
  formData: FormData,
): Promise<Failure | { value: TransactionInput; form: TransactionForm }> {
  const parsed = TransactionForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return {
      field: "form",
      message: "Форма пришла неполной. Обновите страницу.",
    };
  }
  const form = parsed.data;

  let occurredAt: string | undefined;
  if (form.occurredAt !== form.occurredAtInitial) {
    if (!DATE_TIME_LOCAL.test(form.occurredAt)) {
      return { field: "occurredAt", message: "Укажите дату и время" };
    }
    occurredAt = fromOwnerDateTime(form.occurredAt).toISOString();
  }

  let categoryId = form.category;
  if (form.type === "expense" && form.category === "new") {
    const category = await findOrCreateCategory(form.newCategory);
    if (!("id" in category)) return category;
    categoryId = category.id;
  }

  const side = {
    walletId: form.wallet,
    currency: form.currency,
    amount: normalizeAmount(form.amount),
  };
  const fee = form.feeAmount
    ? { currency: form.feeCurrency, amount: normalizeAmount(form.feeAmount) }
    : undefined;
  const note = form.note || undefined;
  const raw = {
    income: { type: "income", to: side, occurredAt, note },
    expense: { type: "expense", from: side, fee, categoryId, occurredAt, note },
    transfer: {
      type: "transfer",
      from: side,
      to: {
        walletId: form.toWallet,
        currency: form.toCurrency,
        amount:
          form.toCurrency === form.currency
            ? side.amount
            : normalizeAmount(form.toAmount),
      },
      fee,
      occurredAt,
      note,
    },
    adjustment: {
      type: "adjustment",
      [form.direction === "in" ? "to" : "from"]: side,
      occurredAt,
      note,
    },
  }[form.type];

  const input = TransactionInput.safeParse(raw);
  if (!input.success) {
    const [issue] = input.error.issues;
    return issueState(form.type, issue);
  }
  return { value: input.data, form };
}

/** Found by name first: after a failed save the owner sends the same new category again. */
async function findOrCreateCategory(
  name: string,
): Promise<Failure | { id: string }> {
  if (!name)
    return { field: "category", message: "Введите имя новой категории" };
  const existing = await listCategories();
  if (existing instanceof Error) return unexpected(existing);
  const found = existing.find(
    (category) => category.name.toLowerCase() === name.toLowerCase(),
  );
  if (found) return found;
  const created = await createCategory(name);
  if (created instanceof ValidationError) {
    return { field: "category", message: created.message };
  }
  if (created instanceof Error) return unexpected(created);
  return created;
}

function issueState(
  type: TransactionForm["type"],
  issue: z.core.$ZodIssue | undefined,
): Failure {
  const [side, key] = issue?.path ?? [];
  const message = issue?.message ?? "Проверьте поля формы";
  if (key === "walletId") return { field: "form", message: "Выберите кошелёк" };
  if (key === "currency") return { field: "form", message: "Выберите валюту" };
  if (side === "categoryId") {
    return { field: "category", message: "Выберите категорию" };
  }
  const field: FormField =
    side === "fee"
      ? "feeAmount"
      : side === "categoryId"
        ? "category"
        : side === "occurredAt"
          ? "occurredAt"
          : side === "to" && type === "transfer"
            ? "toAmount"
            : side === "from" || side === "to"
              ? "amount"
              : "form";
  return { field, message };
}

async function finishTransaction(
  written: Error | Written,
  form: TransactionForm,
): Promise<FormState> {
  if (written instanceof InsufficientFundsError) {
    const currencies = await listCurrencies();
    const list = currencies instanceof Error ? [] : currencies;
    const currency = String(written.currency);
    return {
      field:
        written.currency === form.currency
          ? "amount"
          : written.currency === form.feeCurrency
            ? "feeAmount"
            : "form",
      message: `Недостаточно средств: в «${written.wallet}» ${money(String(written.balance), currency, list)}, а нужно ${money(String(written.required), currency, list)}`,
    };
  }
  if (written instanceof ValidationError || written instanceof NotFoundError) {
    return { field: "form", message: written.message };
  }
  if (written instanceof Error) return unexpected(written);
  done(`/finance/transactions/${written.transaction.id}`);
}

function unexpected(error: Error): Failure {
  console.error("Финансы: сбой формы транзакции", error);
  return {
    field: "form",
    message: "Не получилось записать. Попробуйте ещё раз.",
  };
}

/**
 * `redirect` and `notFound` throw by Next's contract, so this ends the action. A domain error
 * becomes `expected` in the query; anything else is logged first.
 */
function fail(back: string, error: Error, expected: FormErrorCode): never {
  if (error instanceof NotFoundError) notFound();
  if (error instanceof ValidationError) redirect(`${back}?error=${expected}`);
  if (error instanceof InsufficientFundsError) redirect(`${back}?error=funds`);
  console.error("Финансы: сбой действия", error);
  redirect(`${back}?error=internal`);
}

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function done(path: string): never {
  revalidatePath("/finance", "layout");
  redirect(path);
}
