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
  lastMessageAt,
  loadHistory,
  openTelegramConversation,
  reportLostTurns,
  saveSummary,
} from "./chat-store";
import { db } from "./db";
import { resetMemory } from "./memory/memory.test-utils";

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
  await resetMemory();
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
    expect(unwrap(await loadHistory(current)).messages).toEqual([]);
    expect(texts(unwrap(await loadHistory(old)).messages)).toEqual(["до /new"]);
  });
});

describe("beginTurn and loadHistory", () => {
  it("keeps the history in processing order across turns", async () => {
    const conversationId = unwrap(await openTelegramConversation(THREAD));

    const first = unwrap(
      await beginTurn(conversationId, [owner("a"), owner("b"), owner("c")]),
    ).turnId;
    unwrap(await finishTurn(first, agent("ответ")));
    const second = unwrap(await beginTurn(conversationId, [owner("d")])).turnId;

    expect(texts(unwrap(await loadHistory(conversationId)).messages)).toEqual([
      "a",
      "b",
      "c",
      "ответ",
      "d",
    ]);
    expect((await turnRow(second))?.status).toBe("processing");
  });

  it("returns the row of the last owner message of the series as the source of memory writes", async () => {
    const conversationId = unwrap(await openTelegramConversation(THREAD));

    const { ownerMessageId } = unwrap(
      await beginTurn(conversationId, [owner("a"), owner("b"), owner("c")]),
    );

    const [row] = await db
      .select({ uiMessage: messages.uiMessage })
      .from(messages)
      .where(eq(messages.id, ownerMessageId));
    expect(row?.uiMessage.id).toBe("owner-c");
  });

  it("returns the last 50 messages, oldest first", async () => {
    const conversationId = unwrap(await openTelegramConversation(THREAD));
    const series = Array.from({ length: 55 }, (_, index) =>
      owner(String(index + 1)),
    );

    unwrap(await beginTurn(conversationId, [owner("0"), ...series]));

    const history = texts(unwrap(await loadHistory(conversationId)).messages);
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
    expect(texts(unwrap(await loadHistory(conversationId)).messages)).toEqual([
      "до",
    ]);
  });

  it("returns an error for a damaged message in the database", async () => {
    const conversationId = unwrap(await openTelegramConversation(THREAD));
    await db
      .insert(messages)
      .values({ conversationId, uiMessage: { role: "user" } as never });

    expect(await loadHistory(conversationId)).toBeInstanceOf(Error);
  });
});

describe("the summary and its cursor", () => {
  async function conversationOf(count: number) {
    const conversationId = unwrap(await openTelegramConversation(THREAD));
    const series = Array.from({ length: count }, (_, index) =>
      owner(String(index + 1)),
    );
    const [first, ...rest] = series;
    if (!first) throw new Error("Пустая серия");
    unwrap(await beginTurn(conversationId, [first, ...rest]));
    const rows = await db
      .select({ seq: messages.seq })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.seq);
    return { conversationId, seqs: rows.map((row) => row.seq) };
  }

  async function summarize(
    conversationId: string,
    throughSeq: number,
    from: number | null,
    summary = "Выбирали ноутбук",
  ): Promise<boolean> {
    return db.transaction((tx) =>
      saveSummary(
        tx,
        conversationId,
        { title: "Выбор ноутбука", summary, throughSeq },
        from,
      ),
    );
  }

  it("gives the history as the summary and the messages after the cursor (П16)", async () => {
    const { conversationId, seqs } = await conversationOf(5);

    expect(await summarize(conversationId, seqs[2] ?? 0, null)).toBe(true);

    const history = unwrap(await loadHistory(conversationId));
    expect(history.summary).toBe("Выбирали ноутбук");
    expect(texts(history.messages)).toEqual(["4", "5"]);
  });

  it("gives the last 50 messages when the cursor lags 200 messages behind (E12)", async () => {
    const { conversationId, seqs } = await conversationOf(250);
    await summarize(conversationId, seqs[49] ?? 0, null);

    const history = texts(unwrap(await loadHistory(conversationId)).messages);

    expect(history).toHaveLength(50);
    expect(history[0]).toBe("201");
    expect(history.at(-1)).toBe("250");
  });

  it("moves the cursor only from the value it had (E1)", async () => {
    const { conversationId, seqs } = await conversationOf(5);

    expect(await summarize(conversationId, seqs[1] ?? 0, null, "первая")).toBe(
      true,
    );
    expect(await summarize(conversationId, seqs[3] ?? 0, null, "вторая")).toBe(
      false,
    );
    expect(
      await summarize(conversationId, seqs[3] ?? 0, seqs[2] ?? 0, "вторая"),
    ).toBe(false);
    expect(unwrap(await loadHistory(conversationId)).summary).toBe("первая");
    expect(
      await summarize(conversationId, seqs[3] ?? 0, seqs[1] ?? 0, "третья"),
    ).toBe(true);
    const history = unwrap(await loadHistory(conversationId));
    expect(history.summary).toBe("третья");
    expect(texts(history.messages)).toEqual(["5"]);
  });

  it("gives the time and the title of the last message of the open conversation, and nothing once it is closed (П18)", async () => {
    const { conversationId } = await conversationOf(2);
    await summarize(conversationId, 0, null);
    const [last] = await db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.conversationId, conversationId));

    expect(unwrap(await lastMessageAt(THREAD))).toEqual({
      conversationId,
      title: "Выбор ноутбука",
      at: last?.createdAt,
    });
    expect(unwrap(await closeTelegramConversation(THREAD))).toBe(
      conversationId,
    );
    expect(unwrap(await lastMessageAt(THREAD))).toBeNull();
    expect(unwrap(await closeTelegramConversation(THREAD))).toBeUndefined();
  });
});

describe("turn outcomes", () => {
  it("finishTurn marks the turn done, failTurn keeps the error, awaitLogin waits for login", async () => {
    const conversationId = unwrap(await openTelegramConversation(THREAD));
    const answered = unwrap(
      await beginTurn(conversationId, [owner("a")]),
    ).turnId;
    const failed = unwrap(await beginTurn(conversationId, [owner("b")])).turnId;
    const waiting = unwrap(
      await beginTurn(conversationId, [owner("c")]),
    ).turnId;

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

  it("failTurn and awaitLogin save the partial answer together with the status", async () => {
    const conversationId = unwrap(await openTelegramConversation(THREAD));
    const failed = unwrap(await beginTurn(conversationId, [owner("a")])).turnId;
    unwrap(await failTurn(failed, new Error("overloaded"), agent("часть a")));
    const waiting = unwrap(
      await beginTurn(conversationId, [owner("b")]),
    ).turnId;
    unwrap(await awaitLogin(waiting, agent("часть b")));

    expect(texts(unwrap(await loadHistory(conversationId)).messages)).toEqual([
      "a",
      "часть a",
      "b",
      "часть b",
    ]);
    expect((await turnRow(failed))?.status).toBe("failed");
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
    expect(texts(unwrap(await loadHistory(conversationId)).messages)).toEqual([
      "a",
    ]);
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
    const lost = unwrap(await beginTurn(conversationId, [owner("a")])).turnId;
    const answered = unwrap(
      await beginTurn(conversationId, [owner("b")]),
    ).turnId;
    const waiting = unwrap(
      await beginTurn(conversationId, [owner("c")]),
    ).turnId;
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
