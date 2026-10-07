import { unwrap } from "@spotsccc/error-as-value";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_URL,
  codexAnswer,
  heldCodexAnswer,
  signIn,
} from "../chatgpt.test-utils";
import { db } from "../db";
import {
  deliver,
  deliverInBackground,
  FakeTelegram,
  historyIn,
  resetChats,
  stubNetwork,
  textMessage,
  turnsIn,
} from "./telegram.test-utils";

const CHAT = 901;

/** Two turns, each ending with an edit that the adapter paces at about one per second. */
const TIMEOUT_MS = 20_000;

let telegram: FakeTelegram;
let modelCalls: number;

/**
 * The bot of a new function instance: its own module graph, so its own
 * Postgres pool and Chat SDK instance, sharing only the database.
 */
async function newInstance() {
  vi.resetModules();
  const { getBot } = await import("./bot");
  return unwrap(getBot());
}

/** Answers model requests with `answer` and counts them; any other request fails the test. */
function model(answer: (call: number) => Response): void {
  stubNetwork(telegram, (url) => {
    if (url !== CODEX_URL) throw new Error(`Неожиданный запрос: ${url}`);
    modelCalls += 1;
    return answer(modelCalls);
  });
}

beforeEach(async () => {
  await resetChats();
  await signIn();
  telegram = new FakeTelegram();
  modelCalls = 0;
});

afterEach(() => {
  expect(telegram.unhandled).toEqual([]);
});

describe("Telegram bot on Postgres state", { timeout: TIMEOUT_MS }, () => {
  it("creates its tables when it connects to a database without them", async () => {
    await db.execute(sql`
      DROP TABLE IF EXISTS chat_state_subscriptions, chat_state_locks,
        chat_state_cache, chat_state_lists, chat_state_queues`);
    model(() => codexAnswer("pong"));

    await deliver(await newInstance(), textMessage(CHAT, "ping"));

    const tables = await db.execute<{ name: string }>(sql`
      SELECT tablename AS name FROM pg_tables
      WHERE schemaname = 'public' AND tablename LIKE 'chat_state_%'
      ORDER BY tablename`);
    expect(tables.rows.map((row) => row.name)).toEqual([
      "chat_state_cache",
      "chat_state_lists",
      "chat_state_locks",
      "chat_state_queues",
      "chat_state_subscriptions",
    ]);
    expect(telegram.textsIn(CHAT)).toEqual(["pong"]);
  });

  it("handles an update that Telegram resends to another instance once", async () => {
    model(() => codexAnswer("pong"));
    const update = textMessage(CHAT, "ping");

    await deliver(await newInstance(), update);
    await deliver(await newInstance(), update);

    expect(modelCalls).toBe(1);
    expect(await turnsIn(CHAT)).toEqual([{ status: "done", error: null }]);
    expect(telegram.textsIn(CHAT)).toEqual(["pong"]);
  });

  it("answers the messages that arrive at another instance during a turn with one turn after it", async () => {
    const held = heldCodexAnswer("first answer");
    let onFirstModelCall = () => {};
    const firstTurnRunning = new Promise<void>((resolve) => {
      onFirstModelCall = resolve;
    });
    model((call) => {
      if (call > 1) return codexAnswer("second answer");
      onFirstModelCall();
      return held.response;
    });
    const first = await newInstance();
    const second = await newInstance();

    const turnA = await deliverInBackground(first, textMessage(CHAT, "A"));
    await firstTurnRunning;
    for (const text of ["B", "C", "D"]) {
      await deliver(second, textMessage(CHAT, text));
    }
    held.release();
    await turnA.handled;

    expect(await turnsIn(CHAT)).toEqual([
      { status: "done", error: null },
      { status: "done", error: null },
    ]);
    expect(await historyIn(CHAT)).toEqual([
      "A",
      "first answer",
      "B",
      "C",
      "D",
      "second answer",
    ]);
    expect(telegram.textsIn(CHAT)).toEqual(["first answer", "second answer"]);
  });
});
