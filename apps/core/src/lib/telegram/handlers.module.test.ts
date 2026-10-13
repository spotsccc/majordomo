import { zstdDecompressSync } from "node:zlib";
import {
  balances,
  conversations,
  rates,
  transactions,
  wallets,
} from "@repo/db";
import { unwrap } from "@spotsccc/error-as-value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_URL,
  codexAnswer,
  codexToolCall,
  heldCodexAnswer,
  signIn,
  signOut,
} from "../chatgpt.test-utils";
import { beginTurn, finishTurn, openTelegramConversation } from "../chat-store";
import { db } from "../db";
import {
  createTransaction,
  createWallet,
  listCategories,
  listTransactions,
} from "../finance/finance-store";
import { TransactionInput } from "../finance/money";
import { getBot } from "./bot";
import {
  commandMessage,
  deliver,
  deliverInBackground,
  FakeTelegram,
  historyIn,
  photoMessage,
  resetChats,
  STRANGER_ID,
  stubNetwork,
  textMessage,
  turnsIn,
  VOICE_BYTES,
  voiceMessage,
} from "./telegram.test-utils";

const CHAT = 900;

/** A turn ends with an edit that the adapter paces at about one per second. */
const TIMEOUT_MS = 15_000;

const LOGIN_REQUIRED = "Нужно войти в ChatGPT: войдите в веб-версии Majordomo.";
const UNSUPPORTED =
  "Понимаю только текст и голосовые, остальные вложения пропускаю.";
const VOICE_FAILED =
  "Не смог распознать голосовое, повторите текстом или ещё раз.";

const XAI_STT_URL = "https://api.x.ai/v1/stt";

const bot = unwrap(getBot());
let telegram: FakeTelegram;
let modelCalls: number;
let modelBodies: string[];
let transcriptions: {
  type: string;
  bytes: Uint8Array;
  authorization: string | null;
}[];

function network(answer: (url: string) => Response | Promise<Response>): void {
  stubNetwork(telegram, async (url, init) => {
    if (url === CODEX_URL) {
      modelCalls += 1;
      modelBodies.push(
        init?.body instanceof Uint8Array
          ? zstdDecompressSync(init.body).toString()
          : String(init?.body),
      );
    }
    if (url === XAI_STT_URL) {
      const file = (await new Response(init?.body).formData()).get("file");
      if (!(file instanceof File)) throw new Error("Запрос в xAI без файла");
      transcriptions.push({
        type: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
        authorization: new Headers(init?.headers).get("authorization"),
      });
    }
    return answer(url);
  });
}

function transcript(text: string): Response {
  return Response.json({ text, language: "ru", duration: 3 });
}

/** A 4xx, so `transcribe` does not retry it. */
function undecodableAudio(): Response {
  return Response.json(
    { code: "invalid_argument", error: "Unsupported audio" },
    { status: 400 },
  );
}

beforeEach(async () => {
  await resetChats();
  await db.delete(rates);
  await db.delete(transactions);
  await db.delete(balances);
  await db.delete(wallets);
  await signIn();
  telegram = new FakeTelegram();
  modelCalls = 0;
  modelBodies = [];
  transcriptions = [];
});

async function cashWithPesos() {
  const { id } = unwrap(await createWallet({ name: "Наличные" }));
  unwrap(
    await createTransaction(
      TransactionInput.parse({
        type: "income",
        to: { walletId: id, currency: "ARS", amount: "44700" },
      }),
    ),
  );
  const cafe = unwrap(await listCategories()).find(
    (category) => category.name === "Кафе и рестораны",
  );
  if (!cafe) throw new Error("Нет категории из миграции");
  return codexToolCall("create_transaction", {
    transaction: {
      type: "expense",
      from: { walletId: id, currency: "ARS", amount: "3500" },
      categoryId: cafe.id,
    },
  });
}

function inOrder(...answers: (() => Response)[]): () => Response {
  return () => {
    const answer = answers[modelCalls - 1];
    if (!answer) throw new Error(`Лишний запрос к модели №${modelCalls}`);
    return answer();
  };
}

async function expenseCount() {
  return unwrap(await listTransactions({ type: "expense", limit: 10 }))
    .transactions.length;
}

afterEach(() => {
  expect(telegram.unhandled).toEqual([]);
  expect(telegram.rejected).toEqual([]);
});

function delayedAnswer(text: string, ms: number): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      await new Promise((resolve) => setTimeout(resolve, ms));
      controller.enqueue(new Uint8Array(await codexAnswer(text).arrayBuffer()));
      controller.close();
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("Telegram handlers", { timeout: TIMEOUT_MS }, () => {
  it("answers the owner's message with the agent's answer and saves the turn", async () => {
    network(() => codexAnswer("pong"));

    await deliver(bot, textMessage(CHAT, "ping"));

    expect(telegram.textsIn(CHAT)).toEqual(["pong"]);
    expect(await turnsIn(CHAT)).toEqual([{ status: "done", error: null }]);
    expect(await historyIn(CHAT)).toEqual(["ping", "pong"]);
  });

  it("does not answer or save a message from a stranger", async () => {
    network(() => codexAnswer("pong"));

    await deliver(bot, textMessage(CHAT, "ping", STRANGER_ID));

    expect(telegram.textsIn(CHAT)).toEqual([]);
    expect(modelCalls).toBe(0);
    expect(await turnsIn(CHAT)).toEqual([]);
  });

  it("keeps the text that reached Telegram with a note and fails the turn when the model fails midway", async () => {
    network(() => codexAnswer("half", "overloaded"));

    await deliver(bot, textMessage(CHAT, "ping"));

    expect(telegram.textsIn(CHAT)).toEqual([
      "half\n\n⚠️ Ответ оборвался, попробуйте ещё раз.",
    ]);
    expect(await turnsIn(CHAT)).toEqual([
      { status: "failed", error: expect.stringContaining("overloaded") },
    ]);
    expect(await historyIn(CHAT)).toEqual(["ping"]);
  });

  it("replaces the placeholder with an apology when the model fails before any text", async () => {
    network(() => codexAnswer("", "overloaded"));

    await deliver(bot, textMessage(CHAT, "ping"));

    expect(telegram.textsIn(CHAT)).toEqual([
      "Не получилось ответить, попробуйте ещё раз.",
    ]);
    expect(await turnsIn(CHAT)).toEqual([
      { status: "failed", error: expect.stringContaining("overloaded") },
    ]);
  });

  it("asks to log in without calling the model when there is no ChatGPT session", async () => {
    await signOut();
    network(() => codexAnswer("pong"));

    await deliver(bot, textMessage(CHAT, "ping"));

    expect(telegram.textsIn(CHAT)).toEqual([LOGIN_REQUIRED]);
    expect(modelCalls).toBe(0);
    expect(await turnsIn(CHAT)).toEqual([
      { status: "awaiting_login", error: null },
    ]);
    expect(await historyIn(CHAT)).toEqual(["ping"]);
  });

  it("asks to log in when the ChatGPT session dies during the turn", async () => {
    network((url) =>
      url.startsWith("https://auth.openai.com/")
        ? Response.json({ error: "invalid_grant" }, { status: 400 })
        : new Response("{}", { status: 401 }),
    );

    await deliver(bot, textMessage(CHAT, "ping"));

    expect(telegram.textsIn(CHAT)).toEqual([LOGIN_REQUIRED]);
    expect(await turnsIn(CHAT)).toEqual([
      { status: "awaiting_login", error: null },
    ]);
  });

  it("answers a voice message with a turn over its transcript", async () => {
    network((url) =>
      url === XAI_STT_URL ? transcript("ping") : codexAnswer("pong"),
    );

    await deliver(bot, voiceMessage(CHAT));

    expect(telegram.textsIn(CHAT)).toEqual(["pong"]);
    expect(await turnsIn(CHAT)).toEqual([{ status: "done", error: null }]);
    expect(await historyIn(CHAT)).toEqual(["ping", "pong"]);
    expect(transcriptions).toEqual([
      {
        type: "audio/ogg",
        bytes: VOICE_BYTES,
        authorization: "Bearer xai-test-key",
      },
    ]);
  });

  it("puts the caption of a voice message after its transcript", async () => {
    network((url) =>
      url === XAI_STT_URL ? transcript("купить молоко") : codexAnswer("ok"),
    );

    await deliver(bot, voiceMessage(CHAT, { caption: "в заметки" }));

    expect(await historyIn(CHAT)).toEqual(["купить молоко\n\nв заметки", "ok"]);
  });

  it("answers the queued text and voice messages in their order and tells the owner about the voice it could not transcribe", async () => {
    const held = heldCodexAnswer("first answer");
    let onFirstModelCall = () => {};
    const firstTurnRunning = new Promise<void>((resolve) => {
      onFirstModelCall = resolve;
    });
    network((url) => {
      if (url === XAI_STT_URL) {
        return transcriptions.length === 1
          ? transcript("голос")
          : undecodableAudio();
      }
      if (modelCalls > 1) return codexAnswer("second answer");
      onFirstModelCall();
      return held.response;
    });

    const turnA = await deliverInBackground(bot, textMessage(CHAT, "A"));
    await firstTurnRunning;
    await deliver(bot, voiceMessage(CHAT));
    await deliver(bot, voiceMessage(CHAT));
    await deliver(bot, textMessage(CHAT, "B"));
    held.release();
    await turnA.handled;

    expect(await historyIn(CHAT)).toEqual([
      "A",
      "first answer",
      "голос",
      "B",
      "second answer",
    ]);
    expect(await turnsIn(CHAT)).toEqual([
      { status: "done", error: null },
      { status: "done", error: null },
    ]);
    expect(telegram.textsIn(CHAT)).toEqual([
      "first answer",
      VOICE_FAILED,
      "second answer",
    ]);
  });

  it("tells the owner that it could not transcribe a voice message, without a turn", async () => {
    let answer = undecodableAudio();
    network((url) => (url === XAI_STT_URL ? answer : codexAnswer("pong")));

    await deliver(bot, voiceMessage(CHAT));
    answer = transcript("");
    await deliver(bot, voiceMessage(CHAT));

    expect(transcriptions).toHaveLength(2);
    expect(telegram.textsIn(CHAT)).toEqual([VOICE_FAILED, VOICE_FAILED]);
    expect(modelCalls).toBe(0);
    expect(await turnsIn(CHAT)).toEqual([]);
  });

  it("answers a voice message over 20 MB that it is too long, without downloading it", async () => {
    network(() => codexAnswer("pong"));

    await deliver(bot, voiceMessage(CHAT, { size: 20 * 2 ** 20 + 1 }));

    expect(telegram.textsIn(CHAT)).toEqual([
      "Голосовое слишком длинное, разбейте на части.",
    ]);
    expect(telegram.downloads).toBe(0);
    expect(transcriptions).toEqual([]);
    expect(await turnsIn(CHAT)).toEqual([]);
  });

  it("answers a voice message that transcription is not set up when there is no xAI key", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    vi.resetModules();
    const { getBot: getBotWithoutKey } = await import("./bot");
    network(() => codexAnswer("pong"));

    await deliver(unwrap(getBotWithoutKey()), voiceMessage(CHAT));

    expect(telegram.textsIn(CHAT)).toEqual([
      "Распознавание голосовых не настроено.",
    ]);
    expect(telegram.downloads).toBe(0);
    expect(transcriptions).toEqual([]);
    expect(await turnsIn(CHAT)).toEqual([]);
  });

  it("answers a photo that it understands only text and voice, without a turn", async () => {
    network(() => codexAnswer("pong"));

    await deliver(bot, photoMessage(CHAT));

    expect(telegram.textsIn(CHAT)).toEqual([UNSUPPORTED]);
    expect(modelCalls).toBe(0);
    expect(await turnsIn(CHAT)).toEqual([]);
  });

  it("answers the caption of a photo and tells the owner the photo was skipped", async () => {
    network(() => codexAnswer("pong"));

    await deliver(bot, photoMessage(CHAT, "что это?"));

    expect(telegram.textsIn(CHAT)).toEqual([UNSUPPORTED, "pong"]);
    expect(await historyIn(CHAT)).toEqual(["что это?", "pong"]);
  });

  it("starts a new conversation on /new and keeps the old one", async () => {
    network(() => codexAnswer("pong"));

    await deliver(bot, textMessage(CHAT, "first"));
    await deliver(bot, commandMessage(CHAT, "/new"));
    await deliver(bot, textMessage(CHAT, "second"));

    expect(telegram.textsIn(CHAT)).toEqual([
      "pong",
      "Начали новый диалог.",
      "pong",
    ]);
    expect(await historyIn(CHAT)).toEqual(["second", "pong"]);
    expect(await db.select().from(conversations)).toHaveLength(2);
  });

  it("greets on /start and answers an unknown command", async () => {
    network(() => codexAnswer("pong"));

    await deliver(bot, commandMessage(CHAT, "/start"));
    await deliver(bot, commandMessage(CHAT, "/help"));

    expect(telegram.textsIn(CHAT)).toEqual([
      "Привет! Я Majordomo. Пишите, что нужно; /new начинает новый диалог.",
      "Не знаю такой команды. /new начинает новый диалог.",
    ]);
    expect(modelCalls).toBe(0);
  });

  it("keeps the tool calls in the history and sends them to the model on the next turn (S1)", async () => {
    const spend = await cashWithPesos();
    network(
      inOrder(
        () => spend,
        () => codexAnswer("Записал: 3 500 ARS."),
        () => codexAnswer("ok"),
      ),
    );

    await deliver(
      bot,
      textMessage(CHAT, "потратил 3500 песо на кофе с наличных"),
    );
    await deliver(bot, textMessage(CHAT, "спасибо"));

    expect(telegram.textsIn(CHAT)).toEqual(["Записал: 3 500 ARS.", "ok"]);
    expect(await historyIn(CHAT)).toEqual([
      "потратил 3500 песо на кофе с наличных",
      "Записал: 3 500 ARS.",
      "спасибо",
      "ok",
    ]);
    expect(modelBodies[2]).toContain('"type":"function_call"');
    expect(modelBodies[2]).toContain('"type":"function_call_output"');
    expect(await expenseCount()).toBe(1);
  });

  it("saves the tool calls of a turn that fails after them, so a repeated message is not written twice (E7)", async () => {
    const spend = await cashWithPesos();
    network(
      inOrder(
        () => spend,
        () => codexAnswer("", "overloaded"),
        () => codexAnswer("Эта трата уже записана."),
      ),
    );

    await deliver(
      bot,
      textMessage(CHAT, "потратил 3500 песо на кофе с наличных"),
    );
    await deliver(
      bot,
      textMessage(CHAT, "потратил 3500 песо на кофе с наличных"),
    );

    expect(await turnsIn(CHAT)).toEqual([
      { status: "failed", error: expect.stringContaining("overloaded") },
      { status: "done", error: null },
    ]);
    expect(telegram.textsIn(CHAT)).toEqual([
      "Не получилось ответить, попробуйте ещё раз.",
      "Эта трата уже записана.",
    ]);
    expect(modelBodies[2]).toContain('"type":"function_call_output"');
    expect(await expenseCount()).toBe(1);
  });

  it("shows the whole text written before a tool while the tool runs (E10)", async () => {
    const held = heldCodexAnswer("");
    let onSecondCall = () => {};
    const secondCall = new Promise<void>((resolve) => {
      onSecondCall = resolve;
    });
    network(() => {
      if (modelCalls === 1) {
        return codexToolCall(
          "list_wallets",
          {},
          { text: ["С", "ейчас посмотрю кошельки."] },
        );
      }
      onSecondCall();
      return held.response;
    });

    const turn = await deliverInBackground(
      bot,
      textMessage(CHAT, "что у меня в кошельках?"),
    );
    await secondCall;
    await new Promise((resolve) => setTimeout(resolve, 1600));

    expect(telegram.textsIn(CHAT)).toEqual(["Сейчас посмотрю кошельки."]);
    held.release();
    await turn.handled;
    expect(telegram.textsIn(CHAT)).toEqual(["Сейчас посмотрю кошельки."]);
  });

  it("reads a stored tool call whose input no longer fits the tool (E9)", async () => {
    const conversationId = unwrap(
      await openTelegramConversation(`telegram:${CHAT}`),
    );
    const turnId = unwrap(
      await beginTurn(conversationId, [
        {
          id: "u0",
          role: "user",
          parts: [{ type: "text", text: "кофе 3500" }],
        },
      ]),
    );
    unwrap(
      await finishTurn(turnId, {
        id: "a0",
        role: "assistant",
        parts: [
          {
            type: "tool-create_transaction",
            toolCallId: "call_old",
            state: "output-available",
            input: { amount: 3500, wallet: "cash" },
            output: { id: "old" },
          },
          { type: "text", text: "Записал." },
        ],
      }),
    );
    network(() => codexAnswer("ok"));

    await deliver(bot, textMessage(CHAT, "спасибо"));

    expect(await turnsIn(CHAT)).toEqual([
      { status: "done", error: null },
      { status: "done", error: null },
    ]);
    expect(modelBodies[0]).toContain("call_old");
    expect(telegram.textsIn(CHAT)).toEqual(["ok"]);
  });

  it("sends no empty or repeated edits while a tool step stays silent for seconds", async () => {
    network(
      inOrder(
        () => codexToolCall("list_wallets", {}, { text: ["С", "мотрю."] }),
        () => delayedAnswer("Готово.", 4000),
      ),
    );

    await deliver(bot, textMessage(CHAT, "что в кошельках?"));

    expect(telegram.textsIn(CHAT)).toEqual(["Смотрю.\n\nГотово."]);
    expect(await turnsIn(CHAT)).toEqual([{ status: "done", error: null }]);
  });

  it("waits for the first text when the model is silent at the start", async () => {
    network(inOrder(() => delayedAnswer("pong", 2500)));

    await deliver(bot, textMessage(CHAT, "ping"));

    expect(telegram.textsIn(CHAT)).toEqual(["pong"]);
    expect(await turnsIn(CHAT)).toEqual([{ status: "done", error: null }]);
  });
});
