import { zstdDecompressSync } from "node:zlib";
import { balances, rates, transactions, wallets } from "@repo/db";
import {
  NotLoggedInError,
  ReauthRequiredError,
} from "@repo/openai-subscription";
import { unwrap } from "@spotsccc/error-as-value";
import type { TextStreamPart, ToolSet, UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentErrorCode, runAgentTurn } from "./agent";
import {
  CODEX_URL,
  codexAnswer,
  codexToolCall,
  signIn,
  signOut,
  urlOf,
} from "./chatgpt.test-utils";
import { db } from "./db";
import {
  createTransaction,
  createWallet,
  listCategories,
  listTransactions,
  listWallets,
} from "./finance/finance-store";
import { TransactionInput } from "./finance/money";

const messages: UIMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "ping" }] },
];

async function read(
  stream: AsyncIterable<TextStreamPart<ToolSet>>,
): Promise<{ text: string; errors: unknown[] }> {
  let text = "";
  const errors: unknown[] = [];
  for await (const part of stream) {
    if (part.type === "text-delta") text += part.text;
    if (part.type === "error") errors.push(part.error);
  }
  return { text, errors };
}

function bodyOf(init: RequestInit | undefined): string {
  return init?.body instanceof Uint8Array
    ? zstdDecompressSync(init.body).toString()
    : String(init?.body);
}

function model(...answers: (() => Response)[]): string[] {
  const bodies: string[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (urlOf(input) !== CODEX_URL)
        throw new Error(`Неожиданный запрос ${urlOf(input)}`);
      bodies.push(bodyOf(init));
      const answer = answers[bodies.length - 1];
      if (!answer) throw new Error(`Лишний запрос к модели №${bodies.length}`);
      return answer();
    },
  );
  return bodies;
}

async function cashWithPesos(amount: string) {
  const { id } = unwrap(await createWallet({ name: "Наличные" }));
  unwrap(
    await createTransaction(
      TransactionInput.parse({
        type: "income",
        to: { walletId: id, currency: "ARS", amount },
      }),
    ),
  );
  const cafe = unwrap(await listCategories()).find(
    (category) => category.name === "Кафе и рестораны",
  );
  if (!cafe) throw new Error("Нет категории из миграции");
  return { walletId: id, categoryId: cafe.id };
}

function expenseCall(walletId: string, categoryId: string, amount: unknown) {
  return {
    transaction: {
      type: "expense",
      from: { walletId, currency: "ARS", amount },
      categoryId,
    },
  };
}

async function expenses() {
  return unwrap(await listTransactions({ type: "expense", limit: 10 }))
    .transactions;
}

async function pesos(walletId: string) {
  return unwrap(await listWallets())
    .find((wallet) => wallet.id === walletId)
    ?.balances.find((balance) => balance.currency === "ARS")?.amount;
}

describe("runAgentTurn", () => {
  beforeEach(async () => {
    await signOut();
    await db.delete(rates);
    await db.delete(transactions);
    await db.delete(balances);
    await db.delete(wallets);
  });

  it("streams NotLoggedInError without a ChatGPT session and does not call the model", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchFn);

    const turn = await runAgentTurn({ messages });
    if (turn instanceof Error) throw turn;

    const { errors } = await read(turn.stream);
    expect(errors).toEqual([expect.any(NotLoggedInError)]);
    expect(errors.map(agentErrorCode)).toEqual(["openai_login_required"]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("streams the model answer to the conversation", async () => {
    await signIn();
    const requests: { url: string; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: urlOf(input), body: bodyOf(init) });
        return codexAnswer("pong");
      },
    );

    const turn = await runAgentTurn({ messages });
    if (turn instanceof Error) throw turn;

    expect(await read(turn.stream)).toEqual({ text: "pong", errors: [] });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(CODEX_URL);
    expect(requests[0]?.body).toContain('"ping"');
  });

  it("streams ReauthRequiredError, a login error for the client, when the session dies during the turn", async () => {
    await signIn();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
      urlOf(input).startsWith("https://auth.openai.com/")
        ? Response.json({ error: "invalid_grant" }, { status: 400 })
        : new Response("{}", { status: 401 }),
    );

    const turn = await runAgentTurn({ messages });
    if (turn instanceof Error) throw turn;

    const { errors } = await read(turn.stream);
    expect(errors).toEqual([expect.any(ReauthRequiredError)]);
    expect(errors.map(agentErrorCode)).toEqual(["openai_login_required"]);
  });

  it("streams the partial answer and a model_failed error when the model fails midway", async () => {
    await signIn();
    vi.stubGlobal("fetch", async () => codexAnswer("half", "overloaded"));

    const turn = await runAgentTurn({ messages });
    if (turn instanceof Error) throw turn;

    const { text, errors } = await read(turn.stream);
    expect(text).toBe("half");
    expect(errors).toHaveLength(1);
    expect(errors.map(agentErrorCode)).toEqual(["model_failed"]);
  });

  it("runs tools, writes the expense and answers with the new balance (S1)", async () => {
    await signIn();
    const { walletId, categoryId } = await cashWithPesos("44700");
    const bodies = model(
      () => codexToolCall("list_wallets", {}),
      () =>
        codexToolCall(
          "create_transaction",
          expenseCall(walletId, categoryId, "3500"),
        ),
      () => codexAnswer("Записал: 3 500 ARS. Остаток Наличные — 41 200 ARS."),
    );

    const turn = await runAgentTurn({
      messages: [
        {
          id: "u1",
          role: "user",
          parts: [
            { type: "text", text: "потратил 3500 песо на кофе с наличных" },
          ],
        },
      ],
    });
    if (turn instanceof Error) throw turn;

    expect(await read(turn.stream)).toEqual({
      text: "Записал: 3 500 ARS. Остаток Наличные — 41 200 ARS.",
      errors: [],
    });
    expect(await expenses()).toMatchObject([
      { from: { walletId, amount: "3500" }, category: { id: categoryId } },
    ]);
    expect(await pesos(walletId)).toBe("41200");
    expect(bodies[1]).toContain("function_call_output");
    expect(bodies[1]).toContain(walletId);
    expect(bodies[2]).toContain("41200");
  });

  it("returns a refused write to the model as a value and writes nothing (P1, S6)", async () => {
    await signIn();
    const { walletId, categoryId } = await cashWithPesos("12000");
    const bodies = model(
      () =>
        codexToolCall(
          "create_transaction",
          expenseCall(walletId, categoryId, "50000"),
        ),
      () => codexAnswer("Не записал: на Наличных 12 000 ARS."),
    );

    const turn = await runAgentTurn({ messages });
    if (turn instanceof Error) throw turn;

    expect((await read(turn.stream)).errors).toEqual([]);
    expect(bodies[1]).toContain("insufficient_funds");
    expect(bodies[1]).toContain('\\"balance\\":\\"12000\\"');
    expect(await expenses()).toEqual([]);
    expect(await pesos(walletId)).toBe("12000");
  });

  it("refuses an invalid input before running the tool and lets the model call it again (E6)", async () => {
    await signIn();
    const { walletId, categoryId } = await cashWithPesos("44700");
    const bodies = model(
      () =>
        codexToolCall(
          "create_transaction",
          expenseCall(walletId, categoryId, 3500),
        ),
      () =>
        codexToolCall(
          "create_transaction",
          expenseCall(walletId, categoryId, "3500"),
        ),
      () => codexAnswer("Записал."),
    );

    const turn = await runAgentTurn({ messages });
    if (turn instanceof Error) throw turn;

    expect(await read(turn.stream)).toEqual({ text: "Записал.", errors: [] });
    expect(bodies[1]).toContain("function_call_output");
    expect(await expenses()).toHaveLength(1);
    expect(await pesos(walletId)).toBe("41200");
  });

  it("tells the model the owner's date, time and zone offset, the currencies and the categories (P18)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-12T18:04:05Z"));
    await signIn();
    const bodies = model(() => codexAnswer("ok"));

    const turn = await runAgentTurn({ messages });
    if (turn instanceof Error) throw turn;
    await read(turn.stream);
    vi.useRealTimers();

    const cafe = unwrap(await listCategories()).find(
      (category) => category.name === "Кафе и рестораны",
    );
    expect(bodies[0]).toContain("понедельник, 12 октября 2026 г. в 18:04");
    expect(bodies[0]).toContain("2026-10-12T18:04:05+00:00");
    expect(bodies[0]).toContain("ARS (Аргентинское песо, фиат, 2 знаков)");
    expect(bodies[0]).toContain(`Кафе и рестораны (${cafe?.id})`);
    expect(bodies[0]).toContain('"name":"create_transaction"');
  });

  it("leaves a tool call without a result out of the request (E8)", async () => {
    await signIn();
    const bodies = model(() => codexAnswer("ok"));

    const turn = await runAgentTurn({
      messages: [
        ...messages,
        {
          id: "a1",
          role: "assistant",
          parts: [
            {
              type: "tool-list_wallets",
              toolCallId: "call_unfinished",
              state: "input-available",
              input: {},
            },
          ],
        },
        { id: "u2", role: "user", parts: [{ type: "text", text: "ещё раз" }] },
      ],
    });
    if (turn instanceof Error) throw turn;

    expect(await read(turn.stream)).toEqual({ text: "ok", errors: [] });
    expect(bodies[0]).not.toContain("call_unfinished");
    expect(bodies[0]).toContain("ещё раз");
  });
});
