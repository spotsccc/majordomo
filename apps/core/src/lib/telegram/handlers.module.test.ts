import { conversations } from "@repo/db";
import { unwrap } from "@spotsccc/error-as-value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_URL,
  codexAnswer,
  heldCodexAnswer,
  signIn,
  signOut,
} from "../chatgpt.test-utils";
import { db } from "../db";
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

/** Where the xAI provider sends a transcription request. */
const XAI_STT_URL = "https://api.x.ai/v1/stt";

const bot = unwrap(getBot());
let telegram: FakeTelegram;
let modelCalls: number;
let transcriptions: {
  type: string;
  bytes: Uint8Array;
  authorization: string | null;
}[];

/**
 * Answers the requests that are not for Telegram with `answer`, counting
 * model calls and recording the audio file and the key of each transcription
 * request before it is answered.
 */
function network(answer: (url: string) => Response | Promise<Response>): void {
  stubNetwork(telegram, async (url, init) => {
    if (url === CODEX_URL) modelCalls += 1;
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

/** An xAI transcription response with `text`. */
function transcript(text: string): Response {
  return Response.json({ text, language: "ru", duration: 3 });
}

/** The xAI response to audio it cannot decode; a 4xx is not retried. */
function undecodableAudio(): Response {
  return Response.json(
    { code: "invalid_argument", error: "Unsupported audio" },
    { status: 400 },
  );
}

beforeEach(async () => {
  await resetChats();
  await signIn();
  telegram = new FakeTelegram();
  modelCalls = 0;
  transcriptions = [];
});

afterEach(() => {
  expect(telegram.unhandled).toEqual([]);
});

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
});
