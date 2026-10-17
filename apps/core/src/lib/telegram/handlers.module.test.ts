import { zstdDecompressSync } from "node:zlib";
import {
  balances,
  conversations,
  entries,
  messages,
  rates,
  transactions,
  wallets,
} from "@repo/db";
import { unwrap } from "@spotsccc/error-as-value";
import { asc, desc, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
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
import { addCoreFact, saveEntry } from "../memory/memory-store";
import { ownerTurn } from "../memory/memory.test-utils";
import { getBot } from "./bot";
import {
  commandMessage,
  deliver,
  deliverInBackground,
  FakeTelegram,
  historyIn,
  OWNER_ID,
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
let processingBodies: string[];
let transcriptions: {
  type: string;
  bytes: Uint8Array;
  authorization: string | null;
}[];

/** The request of the processing carries the JSON Schema of its answer in the instructions. */
function isProcessing(body: string): boolean {
  return z
    .object({ instructions: z.string() })
    .parse(JSON.parse(body))
    .instructions.includes('"$schema"');
}

function processed(
  result: unknown = { title: "Разговор", summary: "Сводка", operations: [] },
): Response {
  return codexAnswer(JSON.stringify(result));
}

/**
 * Turns and the processing of a conversation both ask chatgpt.com; the processing gets its own
 * answer and is counted apart, so `modelCalls` and `modelBodies` hold only the turns.
 */
function network(
  answer: (url: string) => Response | Promise<Response>,
  processing: () => Response = () => processed(),
): void {
  stubNetwork(telegram, async (url, init) => {
    if (url === CODEX_URL) {
      const body =
        init?.body instanceof Uint8Array
          ? zstdDecompressSync(init.body).toString()
          : String(init?.body);
      if (isProcessing(body)) {
        processingBodies.push(body);
        return processing();
      }
      modelCalls += 1;
      modelBodies.push(body);
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

const ModelRequest = z.object({
  input: z.array(
    z.looseObject({
      type: z.string().optional(),
      output: z.array(z.object({ text: z.string() })).optional(),
    }),
  ),
});

function toolOutputs(body: string | undefined): unknown[] {
  return ModelRequest.parse(JSON.parse(body ?? "")).input.flatMap((item) =>
    item.type === "function_call_output" && item.output
      ? item.output.map((part): unknown => JSON.parse(part.text))
      : [],
  );
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
  processingBodies = [];
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
    const { turnId } = unwrap(
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

describe("memory in Telegram", { timeout: TIMEOUT_MS }, () => {
  const REMEMBER = "Запомни: у Маши день рождения 14 марта";
  const MASHA = {
    kind: "person",
    title: "Маша",
    text: "день рождения 14 марта",
  };

  async function ownerMessageId(text: string): Promise<string | undefined> {
    const rows = await db
      .select({ id: messages.id, uiMessage: messages.uiMessage })
      .from(messages);
    return rows.find(
      ({ uiMessage }) =>
        uiMessage.role === "user" &&
        uiMessage.parts.some(
          (part) => part.type === "text" && part.text === text,
        ),
    )?.id;
  }

  it("saves «Запомни: у Маши день рождения 14 марта» with this message as the source and answers «Запомнил» (S1)", async () => {
    network(
      inOrder(
        () => codexToolCall("memory_save", MASHA),
        () => codexAnswer("Запомнил: Маша — день рождения 14 марта."),
      ),
    );

    await deliver(bot, textMessage(OWNER_ID, REMEMBER));

    expect(
      await db
        .select({
          title: entries.title,
          text: entries.text,
          sourceMessageId: entries.sourceMessageId,
        })
        .from(entries),
    ).toEqual([
      {
        title: "Маша",
        text: "день рождения 14 марта",
        sourceMessageId: await ownerMessageId(REMEMBER),
      },
    ]);
    expect(telegram.textsIn(OWNER_ID)).toEqual([
      "Запомнил: Маша — день рождения 14 марта.",
    ]);
  });

  it("/memory shows the core by sections and the entries by kind (S5)", async () => {
    const turn = await ownerTurn("Запомни");
    unwrap(
      await addCoreFact(
        { section: "profile", text: "Иван, живёт в Белграде, жена Маша" },
        turn,
      ),
    );
    unwrap(
      await addCoreFact(
        { section: "instructions", text: "Отвечай коротко, без списков" },
        turn,
      ),
    );
    unwrap(
      await saveEntry(
        {
          kind: "plan",
          title: "Мадрид",
          text: "командировка до 20 октября",
          validUntil: new Date(Date.now() + 30 * 24 * 3_600_000),
        },
        turn,
      ),
    );
    unwrap(
      await saveEntry(
        { kind: "person", title: "Маша", text: "жена, день рождения 14 марта" },
        turn,
      ),
    );
    unwrap(
      await saveEntry(
        {
          kind: "fact",
          title: "Квартира в Буэнос-Айресе",
          text: "сдаётся до марта",
        },
        turn,
      ),
    );
    network(() => codexAnswer("pong"));

    await deliver(bot, commandMessage(OWNER_ID, "/memory"));

    expect(telegram.textsIn(OWNER_ID)).toEqual([
      [
        "Ядро",
        "Указания:",
        "• Отвечай коротко, без списков",
        "О владельце:",
        "• Иван, живёт в Белграде, жена Маша",
        "Записи",
        "Люди:",
        "• Маша — жена, день рождения 14 марта",
        "Факты:",
        "• Квартира в Буэнос-Айресе — сдаётся до марта",
        "Планы:",
        "• Мадрид — командировка до 20 октября",
      ].join("\n"),
    ]);
    expect(modelCalls).toBe(0);
  });

  it("/memory sends 5000 characters as two messages split at a line boundary (E9)", async () => {
    const turn = await ownerTurn("Запомни");
    const lines: string[] = [];
    for (let index = 10; index < 26; index += 1) {
      const title = `Запись ${index}`;
      const text = `${index} `.padEnd(300, "ж");
      unwrap(await saveEntry({ kind: "fact", title, text }, turn));
      lines.push(`• ${title} — ${text}`);
    }
    network(() => codexAnswer("pong"));

    await deliver(bot, commandMessage(OWNER_ID, "/memory"));

    const sent = telegram.textsIn(OWNER_ID);
    expect(sent).toHaveLength(2);
    expect(sent.every((text) => text.length <= 4096)).toBe(true);
    expect(sent.join("\n")).toBe(
      ["Ядро", "пусто", "Записи", "Факты:", ...lines].join("\n"),
    );
  });

  it("keeps the entry when the model fails after memory_save and answers a repeated «запомни» with duplicate (E11)", async () => {
    network(
      inOrder(
        () => codexToolCall("memory_save", MASHA),
        () => codexAnswer("", "overloaded"),
        () => codexToolCall("memory_save", MASHA),
        () => codexAnswer("Это уже записано."),
      ),
    );

    await deliver(bot, textMessage(OWNER_ID, REMEMBER));
    await deliver(bot, textMessage(OWNER_ID, REMEMBER));

    expect(await turnsIn(OWNER_ID)).toEqual([
      { status: "failed", error: expect.stringContaining("overloaded") },
      { status: "done", error: null },
    ]);
    const [masha] = await db.select({ id: entries.id }).from(entries);
    expect(toolOutputs(modelBodies[3]).at(-1)).toMatchObject({
      error: { code: "duplicate", id: masha?.id, version: 1 },
    });
    expect(await db.select({ title: entries.title }).from(entries)).toEqual([
      { title: "Маша" },
    ]);
  });

  it("finds the entry with memory_search after /new, and the old message is not in the history (S2)", async () => {
    network(
      inOrder(
        () => codexToolCall("memory_save", MASHA),
        () => codexAnswer("Запомнил."),
        () => codexToolCall("memory_search", { query: "Маша" }),
        () => codexAnswer("Маша родилась 14 марта: подари цветы."),
      ),
    );

    await deliver(bot, textMessage(OWNER_ID, REMEMBER));
    await deliver(bot, commandMessage(OWNER_ID, "/new"));
    await deliver(bot, textMessage(OWNER_ID, "Что подарить Маше?"));

    expect(toolOutputs(modelBodies[3])).toEqual([
      [
        expect.objectContaining({
          title: "Маша",
          text: "день рождения 14 марта",
        }),
      ],
    ]);
    expect(modelBodies[2]).not.toContain(REMEMBER);
    expect(modelBodies[3]).not.toContain(REMEMBER);
    expect(telegram.textsIn(OWNER_ID).at(-1)).toBe(
      "Маша родилась 14 марта: подари цветы.",
    );
  });

  it("/memory in a group answers «Только в личном чате» without reading the memory (E14)", async () => {
    const GROUP = -100123;
    network(() => codexAnswer("pong"));

    await db.execute(sql`ALTER SCHEMA memory RENAME TO memory_hidden`);
    try {
      await deliver(bot, commandMessage(GROUP, "/memory"));
    } finally {
      await db.execute(sql`ALTER SCHEMA memory_hidden RENAME TO memory`);
    }

    expect(telegram.textsIn(GROUP)).toEqual(["Только в личном чате."]);
  });
});

describe(
  "processing and the end of a conversation in Telegram",
  {
    timeout: TIMEOUT_MS,
  },
  () => {
    const HOUR = 3_600_000;

    afterEach(() => {
      vi.useRealTimers();
    });

    async function conversationOf(chatId: number) {
      const [row] = await db
        .select({
          id: conversations.id,
          title: conversations.title,
          summary: conversations.summary,
          cursor: conversations.summaryThroughSeq,
          closedAt: conversations.closedAt,
        })
        .from(conversations)
        .where(eq(conversations.externalId, `telegram:${chatId}`))
        .orderBy(asc(conversations.createdAt))
        .limit(1);
      return row;
    }

    async function lastMessageTime(): Promise<number> {
      const [row] = await db
        .select({ createdAt: messages.createdAt })
        .from(messages)
        .orderBy(desc(messages.seq))
        .limit(1);
      if (!row) throw new Error("Сообщений нет");
      return row.createdAt.getTime();
    }

    /** Only `Date` runs ahead, and only ahead of Postgres: state-pg compares its expiries with `now()`. */
    async function clockAt(instant: number): Promise<void> {
      vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
      vi.setSystemTime(instant);
      await signIn();
    }

    /** A future day of the owner (UTC in the tests), so the faked clock stays ahead of Postgres. */
    function futureDay(): number {
      const day = new Date(Date.now() + 2 * 24 * HOUR);
      return Date.UTC(
        day.getUTCFullYear(),
        day.getUTCMonth(),
        day.getUTCDate(),
      );
    }

    async function openConversationWith(
      count: number,
      { title, at }: { title?: string; at?: Date } = {},
    ): Promise<string> {
      const conversationId = unwrap(
        await openTelegramConversation(`telegram:${CHAT}`),
      );
      if (title) {
        await db
          .update(conversations)
          .set({ title })
          .where(eq(conversations.id, conversationId));
      }
      await db.insert(messages).values(
        Array.from({ length: count }, (_, index) => ({
          conversationId,
          uiMessage: {
            id: `seed-${index}`,
            role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
            parts: [{ type: "text" as const, text: `Реплика ${index + 1}` }],
          },
          createdAt: at,
        })),
      );
      return conversationId;
    }

    it("/new starts the processing of the closed conversation (П10)", async () => {
      network(() => codexAnswer("pong"));

      await deliver(bot, textMessage(CHAT, "ping"));
      await deliver(bot, commandMessage(CHAT, "/new"));

      expect(processingBodies).toHaveLength(1);
      expect(await conversationOf(CHAT)).toMatchObject({
        title: "Разговор",
        summary: "Сводка",
        cursor: expect.any(Number),
        closedAt: expect.any(Date),
      });
    });

    it("processes the conversation after the answer once 41 messages are unprocessed (П10)", async () => {
      await openConversationWith(39);
      network(() => codexAnswer("pong"));

      await deliver(bot, textMessage(CHAT, "ping"));

      expect(telegram.textsIn(CHAT)).toEqual(["pong"]);
      expect(processingBodies).toHaveLength(1);
      expect(await conversationOf(CHAT)).toMatchObject({
        summary: "Сводка",
        cursor: expect.any(Number),
        closedAt: null,
      });
    });

    it("answers the next message before the processing ends when the model holds the answer of the processing", async () => {
      const held = heldCodexAnswer(
        JSON.stringify({
          title: "Разговор",
          summary: "Сводка",
          operations: [],
        }),
      );
      let onProcessing = () => {};
      const processing = new Promise<void>((resolve) => {
        onProcessing = resolve;
      });
      network(
        () => codexAnswer("pong"),
        () => {
          onProcessing();
          return held.response;
        },
      );
      await deliver(bot, textMessage(CHAT, "ping"));

      const closing = await deliverInBackground(
        bot,
        commandMessage(CHAT, "/new"),
      );
      await processing;
      await deliver(bot, textMessage(CHAT, "второй"));

      expect(telegram.textsIn(CHAT)).toEqual([
        "pong",
        "Начали новый диалог.",
        "pong",
      ]);
      expect((await conversationOf(CHAT))?.cursor).toBeNull();
      held.release();
      await closing.handled;
      expect((await conversationOf(CHAT))?.cursor).toEqual(expect.any(Number));
    });

    it("closes and processes the conversation on a message 3 h 1 min after the agent's answer and answers in a new one (П18)", async () => {
      network(() => codexAnswer("pong"));
      await deliver(bot, textMessage(CHAT, "ping"));
      await clockAt((await lastMessageTime()) + 3 * HOUR + 60_000);

      await deliver(bot, textMessage(CHAT, "второй"));

      const sent = telegram.textsIn(CHAT);
      expect(sent).toHaveLength(3);
      expect(sent[1]).toMatch(/^Новый разговор\. Прошлый — (сегодня|вчера)\.$/);
      expect(sent[2]).toBe("pong");
      expect(processingBodies).toHaveLength(1);
      expect(await conversationOf(CHAT)).toMatchObject({
        summary: "Сводка",
        closedAt: expect.any(Date),
      });
      expect(await historyIn(CHAT)).toEqual(["второй", "pong"]);
    });

    it("names yesterday and the title when the last message of «Выбор ноутбука» was yesterday at 21:40 (П18, S8)", async () => {
      const today = futureDay();
      await openConversationWith(2, {
        title: "Выбор ноутбука",
        at: new Date(today - 24 * HOUR + 21 * HOUR + 40 * 60_000),
      });
      await clockAt(today + 9 * HOUR);
      network(() => codexAnswer("Уточни, о каком варианте речь?"));

      await deliver(bot, textMessage(CHAT, "А второй вариант сколько весит?"));

      expect(telegram.textsIn(CHAT)).toEqual([
        "Новый разговор. Прошлый — вчера, «Выбор ноутбука».",
        "Уточни, о каком варианте речь?",
      ]);
    });

    it("names only the day when the conversation without a title paused the same day (П18)", async () => {
      const today = futureDay();
      await openConversationWith(2, { at: new Date(today + 11.5 * HOUR) });
      await clockAt(today + 15 * HOUR);
      network(() => codexAnswer("pong"));

      await deliver(bot, textMessage(CHAT, "ping"));

      expect(telegram.textsIn(CHAT)).toEqual([
        "Новый разговор. Прошлый — сегодня.",
        "pong",
      ]);
    });

    it("keeps the conversation on a message 2 h 59 min after the agent's answer (П18)", async () => {
      network(() => codexAnswer("pong"));
      await deliver(bot, textMessage(CHAT, "ping"));
      await clockAt((await lastMessageTime()) + 3 * HOUR - 60_000);

      await deliver(bot, textMessage(CHAT, "второй"));

      expect(telegram.textsIn(CHAT)).toEqual(["pong", "pong"]);
      expect(processingBodies).toEqual([]);
      expect(await historyIn(CHAT)).toEqual(["ping", "pong", "второй", "pong"]);
      expect(await db.select().from(conversations)).toHaveLength(1);
    });

    it("finds a past conversation for «а помнишь позавчера» with history_search, reads it with conversation_read and sends its piece to the model (S4)", async () => {
      const twoDaysAgo = new Date(Date.now() - 48 * HOUR);
      const [past] = await db
        .insert(conversations)
        .values({
          channel: "telegram",
          externalId: `telegram:${CHAT}`,
          title: "Выбор ноутбука",
          summary: "Сравнивали ноутбуки",
          createdAt: twoDaysAgo,
          closedAt: twoDaysAgo,
        })
        .returning({ id: conversations.id });
      const pastId = past?.id ?? "";
      await db.insert(messages).values([
        {
          conversationId: pastId,
          uiMessage: {
            id: "past-1",
            role: "user",
            parts: [
              { type: "text", text: "Какой ноутбук взять: Air или ThinkPad?" },
            ],
          },
          createdAt: twoDaysAgo,
        },
        {
          conversationId: pastId,
          uiMessage: {
            id: "past-2",
            role: "assistant",
            parts: [
              {
                type: "text",
                text: "ThinkPad X1 весит 1,12 кг, Air — 1,24 кг.",
              },
            ],
          },
          createdAt: twoDaysAgo,
        },
      ]);
      const day = twoDaysAgo.toISOString().slice(0, 10);
      network(
        inOrder(
          () =>
            codexToolCall("history_search", {
              query: "ноутбук",
              from: day,
              to: day,
            }),
          () => codexToolCall("conversation_read", { conversationId: pastId }),
          () => codexAnswer("Да: ThinkPad X1 весит 1,12 кг."),
        ),
      );

      await deliver(
        bot,
        textMessage(
          CHAT,
          "А помнишь, позавчера мы обсуждали, какой ноутбук взять?",
        ),
      );

      expect(toolOutputs(modelBodies[1])).toEqual([
        {
          outsideRange: false,
          conversations: [
            expect.objectContaining({ id: pastId, title: "Выбор ноутбука" }),
          ],
        },
      ]);
      expect(modelBodies[2]).toContain("ThinkPad X1 весит 1,12 кг");
      expect(telegram.textsIn(CHAT)).toEqual([
        "Да: ThinkPad X1 весит 1,12 кг.",
      ]);
    });
  },
);
