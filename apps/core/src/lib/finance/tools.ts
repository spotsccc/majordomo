import { NotFoundError, ValidationError } from "@repo/errors";
import { tool } from "ai";
import { z } from "zod";
import { ownerDayRange } from "../owner-time";
import {
  addCurrency,
  archiveWallet,
  createCategory,
  createTransaction,
  createWallet,
  deleteTransaction,
  InsufficientFundsError,
  listCategories,
  listTransactions,
  listWallets,
  restoreTransaction,
  summarize,
  updateTransaction,
  updateWallet,
} from "./finance-store";
import { CurrencyCode, NewCurrency, TransactionInput } from "./money";
import { findCoin, netWorth, ratesOn } from "./rates";

const Day = z.iso.date().describe("день YYYY-MM-DD в часовом поясе владельца");

const Id = z.uuid();

/**
 * OpenAI function parameters need an object at the root, and `anyOf` is in the schema subset
 * OpenAI documents while the `oneOf` of a discriminated union is not.
 */
const Transaction = z
  .union(TransactionInput.options)
  .describe(
    "Суммы — строки с точкой без округления. occurredAt — ISO со смещением владельца, по умолчанию сейчас. Обмен — transfer в тот же кошелёк. Комиссия — в fee, а не в сумме.",
  );

type ToolError = {
  error: {
    code: "not_found" | "validation" | "insufficient_funds" | "internal";
    message: string;
  } & Partial<
    Record<"wallet" | "currency" | "balance" | "required", string | number>
  >;
};

/** An unexpected failure is logged here and reaches the model without its details. */
function result<T>(value: Error | T): T | ToolError {
  if (!(value instanceof Error)) return value;
  if (value instanceof InsufficientFundsError) {
    const { message, wallet, currency, balance, required } = value;
    return {
      error: {
        code: "insufficient_funds",
        message,
        wallet,
        currency,
        balance,
        required,
      },
    };
  }
  if (value instanceof ValidationError) {
    return { error: { code: "validation", message: value.message } };
  }
  if (value instanceof NotFoundError) {
    return { error: { code: "not_found", message: value.message } };
  }
  console.error("Тул финансов: сбой", value);
  return {
    error: { code: "internal", message: "Внутренняя ошибка, попробуйте позже" },
  };
}

export const financeTools = {
  list_wallets: tool({
    description:
      "Кошельки владельца с id и остатками по валютам. Вызови, если id кошелька неизвестен.",
    inputSchema: z.strictObject({
      includeArchived: z.boolean().optional().describe("и архивные кошельки"),
    }),
    execute: async ({ includeArchived }) =>
      result(await listWallets({ includeArchived })),
  }),

  create_wallet: tool({
    description: "Новый кошелёк; currencies открывает в нём нулевые остатки.",
    inputSchema: z.strictObject({
      name: z.string(),
      note: z.string().optional(),
      currencies: z.array(CurrencyCode).optional(),
    }),
    execute: async (input) => result(await createWallet(input)),
  }),

  update_wallet: tool({
    description:
      "Переименовать кошелёк, сменить или стереть (null) заметку, убрать в архив.",
    inputSchema: z.strictObject({
      walletId: Id,
      name: z.string().optional(),
      note: z.string().nullable().optional(),
      archive: z.literal(true).optional(),
    }),
    execute: async ({ walletId, name, note, archive }) => {
      if (name === undefined && note === undefined && !archive) {
        return result(
          new ValidationError({ message: "Передайте name, note или archive" }),
        );
      }
      if (name !== undefined || note !== undefined) {
        const updated = await updateWallet(walletId, { name, note });
        if (updated instanceof Error || !archive) return result(updated);
      }
      return result(await archiveWallet(walletId));
    },
  }),

  list_transactions: tool({
    description:
      "Транзакции от новых к старым, не больше 50 за раз; nextCursor — следующая страница.",
    inputSchema: z.strictObject({
      walletId: Id.optional(),
      type: z.enum(["income", "expense", "transfer", "adjustment"]).optional(),
      currency: CurrencyCode.optional(),
      categoryId: Id.optional(),
      from: Day.optional().describe("первый день, включительно"),
      to: Day.optional().describe("последний день, включительно"),
      search: z.string().optional().describe("подстрока заметки"),
      deleted: z.boolean().optional().describe("только удалённые"),
      limit: z.int().min(1).max(50).default(20),
      cursor: z.string().optional(),
    }),
    execute: async ({ from, to, ...filter }) =>
      result(
        await listTransactions({
          ...filter,
          from: from ? ownerDayRange(from).from : undefined,
          to: to ? ownerDayRange(to).to : undefined,
        }),
      ),
  }),

  create_transaction: tool({
    description:
      "Записать пополнение, трату (с categoryId), перевод или обмен (transfer), корректировку. Возвращает транзакцию и новые остатки.",
    inputSchema: z.strictObject({ transaction: Transaction }),
    execute: async ({ transaction }) =>
      result(await createTransaction(transaction)),
  }),

  update_transaction: tool({
    description:
      "Заменить транзакцию целиком новым входом, включая комиссию; без occurredAt дата остаётся прежней.",
    inputSchema: z.strictObject({ id: Id, transaction: Transaction }),
    execute: async ({ id, transaction }) =>
      result(await updateTransaction(id, transaction)),
  }),

  delete_transaction: tool({
    description:
      "Удалить транзакцию (её можно восстановить). Возвращает её и новые остатки.",
    inputSchema: z.strictObject({ id: Id }),
    execute: async ({ id }) => result(await deleteTransaction(id)),
  }),

  restore_transaction: tool({
    description: "Восстановить удалённую транзакцию.",
    inputSchema: z.strictObject({ id: Id }),
    execute: async ({ id }) => result(await restoreTransaction(id)),
  }),

  list_categories: tool({
    description: "Категории трат с id.",
    inputSchema: z.strictObject({
      includeArchived: z.boolean().optional().describe("и архивные"),
    }),
    execute: async ({ includeArchived }) =>
      result(await listCategories({ includeArchived })),
  }),

  create_category: tool({
    description:
      "Новая категория трат, только если ни одна существующая не подходит.",
    inputSchema: z.strictObject({ name: z.string() }),
    execute: async ({ name }) => result(await createCategory(name)),
  }),

  summarize: tool({
    description:
      "Доходы, траты по категориям и комиссии за дни from–to включительно, без переводов и корректировок; с inCurrency — ещё итоги в одной валюте по курсу дня каждой операции.",
    inputSchema: z.strictObject({
      from: Day,
      to: Day,
      walletId: Id.optional(),
      inCurrency: CurrencyCode.optional(),
    }),
    execute: async ({ from, to, walletId, inCurrency }) =>
      result(
        await summarize({
          from: ownerDayRange(from).from,
          to: ownerDayRange(to).to,
          walletId,
          inCurrency,
        }),
      ),
  }),

  net_worth: tool({
    description:
      "Все остатки в одной валюте: сумма, дата курсов и валюты без курса.",
    inputSchema: z.strictObject({ inCurrency: CurrencyCode.default("USD") }),
    execute: async ({ inCurrency }) => result(await netWorth(inCurrency)),
  }),

  get_rates: tool({
    description:
      "Сколько единиц inCurrency стоит единица каждой валюты на день date (UTC, по умолчанию сегодня).",
    inputSchema: z.strictObject({
      inCurrency: CurrencyCode.default("USD"),
      date: z.iso.date().optional(),
    }),
    execute: async ({ inCurrency, date }) =>
      result(
        await ratesOn(
          inCurrency,
          date ?? new Date().toISOString().slice(0, 10),
        ),
      ),
  }),

  add_currency: tool({
    description:
      "Добавить валюту в справочник. Для криптовалюты без rateId возвращает needsChoice — монеты CoinGecko с этим тикером: покажи их владельцу и вызови снова с выбранным rateId.",
    inputSchema: z.strictObject({
      code: CurrencyCode,
      name: z.string(),
      kind: z.enum(["fiat", "crypto"]),
      scale: z.int().min(0).max(18).describe("знаков после точки"),
      rateId: z.string().optional().describe("id монеты CoinGecko"),
    }),
    execute: async (input) => {
      if (input.kind === "crypto" && input.rateId === undefined) {
        const candidates = await findCoin(input.code);
        return candidates instanceof Error
          ? result(candidates)
          : { needsChoice: { candidates } };
      }
      const currency = NewCurrency.safeParse(input);
      if (!currency.success) {
        return result(
          new ValidationError({ message: z.prettifyError(currency.error) }),
        );
      }
      return result(await addCurrency(currency.data));
    },
  }),
};
