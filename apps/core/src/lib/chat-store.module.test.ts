import { conversations, messages, turns } from "@repo/db";
import { unwrap } from "@spotsccc/error-as-value";
import type { UIMessage } from "ai";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitLogin,
  beginTurn,
  closeTelegramConversation,
  failTurn,
  finishTurn,
  loadHistory,
  openTelegramConversation,
  reportLostTurns,
} from "./chat-store";
import { db } from "./db";

const THREAD = "telegram:100";
const TURN_DEADLINE_MS = 330_000;

function owner(text: string): UIMessage {
  return { id: `owner-${text}`, role: "user", parts: [{ type: "text", text }] };
}

function agent(text: string): UIMessage {
  return {
    id: `agent-${text}`,
    role: "assistant",
    parts: [{ type: "text", text }],
  };
}

function texts(history: UIMessage[]): string[] {
  return history.map((message) =>
    message.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join(""),
  );
}

async function turnRow(turnId: string) {
  const [row] = await db.select().from(turns).where(eq(turns.id, turnId));
  return row;
}

beforeEach(async () => {
  await db.delete(turns);
  await db.delete(messages);
  await db.delete(conversations);
});

describe("openTelegramConversation", () => {
  it("returns the same open conversation for a chat and another one for another chat", async () => {
    const first = unwrap(await openTelegramConversation(THREAD));

    expect(unwrap(await openTelegramConversation(THREAD))).toBe(first);
    expect(unwrap(await openTelegramConversation("telegram:200"))).not.toBe(
      first,
    );
  });

  it("opens one conversation when first messages of a chat arrive at once", async () => {
    const ids = await Promise.all(
      Array.from({ length: 5 }, () => openTelegramConversation(THREAD)),
    );

    expect(new Set(ids.map((id) => unwrap(id))).size).toBe(1);
    expect(await db.select().from(conversations)).toHaveLength(1);
  });

  it("opens a new conversation after closeTelegramConversation and keeps the old history", async () => {
    const old = unwrap(await openTelegramConversation(THREAD));
    unwrap(await beginTurn(old, [owner("до /new")]));

    unwrap(await closeTelegramConversation(THREAD));
    const current = unwrap(await openTelegramConversation(THREAD));

    expect(current).not.toBe(old);
    expect(unwrap(await loadHistory(current))).toEqual([]);
    expect(texts(unwrap(await loadHistory(old)))).toEqual(["до /new"]);
  });
});

describe("beginTurn and loadHistory", () => {
  it("keeps the history in processing order across turns", async () => {
    const conversationId = unwrap(await openTelegramConversation(THREAD));

    const first = unwrap(
      await beginTurn(conversationId, [owner("a"), owner("b"), owner("c")]),
    );
    unwrap(await finishTurn(first, agent("ответ")));
    const second = unwrap(await beginTurn(conversationId, [owner("d")]));

    expect(texts(unwrap(await loadHistory(conversationId)))).toEqual([
      "a",
      "b",
      "c",
      "ответ",
      "d",
    ]);
    expect((await turnRow(second))?.status).toBe("processing");
  });

  it("returns the last 50 messages, oldest first", async () => {
    const conversationId = unwrap(await openTelegramConversation(THREAD));
    const series = Array.from({ length: 55 }, (_, index) =>
      owner(String(index + 1)),
    );

    unwrap(await beginTurn(conversationId, [owner("0"), ...series]));

    const history = texts(unwrap(await loadHistory(conversationId)));
    expect(history).toHaveLength(50);
    expect(history[0]).toBe("6");
    expect(history.at(-1)).toBe("55");
  });

  it("writes neither the turn nor any message of a series that the database rejects", async () => {
    const conversationId = unwrap(await openTelegramConversation(THREAD));
    unwrap(await beginTurn(conversationId, [owner("до")]));

    const rejected = await beginTurn(conversationId, [
      owner("после"),
      null as never,
    ]);

    expect(rejected).toBeInstanceOf(Error);
    expect(await db.select().from(turns)).toHaveLength(1);
    expect(texts(unwrap(await loadHistory(conversationId)))).toEqual(["до"]);
  });

  it("returns an error for a damaged message in the database", async () => {
    const conversationId = unwrap(await openTelegramConversation(THREAD));
    await db
      .insert(messages)
      .values({ conversationId, uiMessage: { role: "user" } as never });

    expect(await loadHistory(conversationId)).toBeInstanceOf(Error);
  });
});

describe("turn outcomes", () => {
  it("finishTurn marks the turn done, failTurn keeps the error, awaitLogin waits for login", async () => {
    const conversationId = unwrap(await openTelegramConversation(THREAD));
    const answered = unwrap(await beginTurn(conversationId, [owner("a")]));
    const failed = unwrap(await beginTurn(conversationId, [owner("b")]));
    const waiting = unwrap(await beginTurn(conversationId, [owner("c")]));

    unwrap(await finishTurn(answered, agent("ответ")));
    unwrap(
      await failTurn(failed, new TypeError("Codex server_error: overloaded")),
    );
    unwrap(await awaitLogin(waiting));

    expect(await turnRow(answered)).toMatchObject({
      status: "done",
      error: null,
    });
    expect(await turnRow(failed)).toMatchObject({
      status: "failed",
      error: "TypeError: Codex server_error: overloaded",
    });
    expect((await turnRow(waiting))?.status).toBe("awaiting_login");
  });

  it("finishTurn of an unknown turn returns an error and saves no answer", async () => {
    const conversationId = unwrap(await openTelegramConversation(THREAD));
    unwrap(await beginTurn(conversationId, [owner("a")]));

    const finished = await finishTurn(
      "00000000-0000-0000-0000-000000000000",
      agent("ответ"),
    );

    expect(finished).toBeInstanceOf(Error);
    expect(texts(unwrap(await loadHistory(conversationId)))).toEqual(["a"]);
  });
});

describe("reportLostTurns", () => {
  const START = new Date("2026-10-06T12:00:00Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports a turn still processing after its deadline once, with its chat", async () => {
    const conversationId = unwrap(await openTelegramConversation(THREAD));
    const lost = unwrap(await beginTurn(conversationId, [owner("a")]));
    const answered = unwrap(await beginTurn(conversationId, [owner("b")]));
    const waiting = unwrap(await beginTurn(conversationId, [owner("c")]));
    unwrap(await finishTurn(answered, agent("ответ")));
    unwrap(await awaitLogin(waiting));

    vi.setSystemTime(START + TURN_DEADLINE_MS);
    unwrap(await beginTurn(conversationId, [owner("d")]));
    expect(unwrap(await reportLostTurns())).toEqual([]);

    vi.setSystemTime(START + TURN_DEADLINE_MS + 1);
    expect(unwrap(await reportLostTurns())).toEqual([
      { turnId: lost, threadId: THREAD },
    ]);
    expect(unwrap(await reportLostTurns())).toEqual([]);
    expect((await turnRow(lost))?.reportedAt).toEqual(
      new Date(START + TURN_DEADLINE_MS + 1),
    );
  });
});
