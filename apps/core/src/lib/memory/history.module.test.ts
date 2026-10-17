import { conversations, messages, type Voice } from "@repo/db";
import { unwrap } from "@spotsccc/error-as-value";
import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import { resetChats } from "../telegram/telegram.test-utils";

type Message = {
  text: string;
  role?: "user" | "assistant";
  at?: string;
  voice?: Voice;
  parts?: UIMessage["parts"];
};

/** The owner's zone is read once, when `config` loads, so the module loads again with it. */
async function historyIn(zone: string) {
  vi.stubEnv("OWNER_TIME_ZONE", zone);
  vi.resetModules();
  return import("./history");
}

async function conversation(
  list: Message[],
  about: { title?: string; summary?: string } = {},
): Promise<{ id: string; seqs: number[] }> {
  const [created] = await db
    .insert(conversations)
    .values({
      channel: "telegram",
      externalId: `telegram:${crypto.randomUUID()}`,
      title: about.title,
      summary: about.summary,
      closedAt: new Date(),
    })
    .returning({ id: conversations.id });
  if (!created) throw new Error("Диалог не создан");
  const seqs: number[] = [];
  for (const { text, role = "user", at, voice, parts } of list) {
    const [row] = await db
      .insert(messages)
      .values({
        conversationId: created.id,
        uiMessage: {
          id: crypto.randomUUID(),
          role,
          parts: parts ?? [{ type: "text", text }],
        },
        voice,
        createdAt: at ? new Date(at) : undefined,
      })
      .returning({ seq: messages.seq });
    if (row) seqs.push(row.seq);
  }
  return { id: created.id, seqs };
}

beforeEach(async () => {
  await resetChats();
});

describe("searchHistory", () => {
  it("finds «позавчера», asked on 12 October at 00:30 in Buenos Aires, as the owner's 10 October from midnight to midnight (E10)", async () => {
    const { searchHistory } = await historyIn("America/Argentina/Buenos_Aires");
    const late = await conversation([
      { text: "Какой ноутбук взять?", at: "2026-10-10T22:30:00-03:00" },
    ]);
    const early = await conversation([
      { text: "Ноутбук нужен лёгкий", at: "2026-10-10T00:10:00-03:00" },
    ]);
    await conversation([
      { text: "Ноутбук сломался", at: "2026-10-09T23:50:00-03:00" },
    ]);
    await conversation([
      { text: "Ноутбук пришёл", at: "2026-10-11T00:10:00-03:00" },
    ]);

    const found = unwrap(
      await searchHistory({
        query: "ноутбук",
        from: "2026-10-10",
        to: "2026-10-10",
      }),
    );

    expect(found.outsideRange).toBe(false);
    expect(found.conversations.map((item) => item.id).sort()).toEqual(
      [late.id, early.id].sort(),
    );
    expect(found.conversations[0]).toMatchObject({
      from: "2026-10-10",
      to: "2026-10-10",
    });
  });

  it("keeps the owner's day of 25 hours whole on the day the clocks go back in Berlin (E10)", async () => {
    const { searchHistory } = await historyIn("Europe/Berlin");
    const morning = await conversation([
      { text: "Ноутбук утром", at: "2026-10-25T00:30:00+02:00" },
    ]);
    const night = await conversation([
      { text: "Ноутбук ночью", at: "2026-10-25T23:30:00+01:00" },
    ]);
    await conversation([
      { text: "Ноутбук накануне", at: "2026-10-24T23:30:00+02:00" },
    ]);
    await conversation([
      { text: "Ноутбук назавтра", at: "2026-10-26T00:10:00+01:00" },
    ]);

    const found = unwrap(
      await searchHistory({ query: "ноутбук", from: "2026-10-25" }),
    );

    expect(found.conversations.map((item) => item.id).sort()).toEqual(
      [morning.id, night.id].sort(),
    );
  });

  it("searches without days and answers outsideRange: true when the days hold nothing (П13)", async () => {
    const { searchHistory } = await historyIn("America/Argentina/Buenos_Aires");
    const laptop = await conversation([
      { text: "Какой ноутбук взять?", at: "2026-10-08T12:00:00-03:00" },
    ]);

    const found = unwrap(
      await searchHistory({
        query: "ноутбук",
        from: "2026-10-10",
        to: "2026-10-10",
      }),
    );

    expect(found).toEqual({
      outsideRange: true,
      conversations: [
        expect.objectContaining({ id: laptop.id, from: "2026-10-08" }),
      ],
    });
  });

  it("finds a voice message by its transcript (E8)", async () => {
    const { searchHistory } = await historyIn("UTC");
    const voice = await conversation([
      {
        text: "надо купить батарейки",
        voice: {
          fileId: "voice-1",
          fileUniqueId: "v1",
          durationSec: 3,
          status: "transcribed",
        },
      },
    ]);

    const found = unwrap(await searchHistory({ query: "батарейки" }));

    expect(found.conversations).toEqual([
      expect.objectContaining({
        id: voice.id,
        matches: [
          expect.objectContaining({
            seq: voice.seqs[0],
            text: expect.stringContaining("батарейки"),
          }),
        ],
      }),
    ]);
  });

  it("finds a word after a line break", async () => {
    const { searchHistory } = await historyIn("UTC");
    const shopping = await conversation([
      { text: "Купил МОЛОКО\n\nПривет\nМир" },
    ]);

    const found = unwrap(await searchHistory({ query: "мир" }));

    expect(found.conversations.map((item) => item.id)).toEqual([shopping.id]);
  });

  it("finds «Выбор ноутбука» by «НОУТБУК» in its title and by «Что мы решили с ноутбуком?», though «решили» is not in it (П13)", async () => {
    const { searchHistory } = await historyIn("UTC");
    const laptop = await conversation([{ text: "Что посоветуешь?" }], {
      title: "Выбор ноутбука",
      summary: "Сравнивали две модели, владелец склонялся к лёгкой",
    });
    await conversation([{ text: "Куда поехать летом?" }], {
      title: "Отпуск",
      summary: "Выбирали море",
    });

    const upper = unwrap(await searchHistory({ query: "НОУТБУК" }));
    const question = unwrap(
      await searchHistory({ query: "Что мы решили с ноутбуком?" }),
    );

    expect(upper.conversations).toEqual([
      expect.objectContaining({
        id: laptop.id,
        title: "Выбор ноутбука",
        summary: "Сравнивали две модели, владелец склонялся к лёгкой",
        matches: [],
      }),
    ]);
    expect(question.conversations.map((item) => item.id)).toEqual([laptop.id]);
  });

  it("finds by «Что решили про MacBook?» the conversation that has «MacBook» only in a message, not in its title and summary (П13)", async () => {
    const { searchHistory } = await historyIn("UTC");
    const compared = await conversation(
      [{ text: "Сравни MacBook Air и ThinkPad X1" }],
      { title: "Выбор ноутбука", summary: "Сравнивали две модели" },
    );

    const found = unwrap(
      await searchHistory({ query: "Что решили про MacBook?" }),
    );

    expect(found.conversations).toEqual([
      expect.objectContaining({
        id: compared.id,
        matches: [
          expect.objectContaining({
            text: expect.stringContaining("MacBook"),
          }),
        ],
      }),
    ]);
  });

  it("gives the 5 most relevant conversations with up to 3 matches each, a summary cut to 300 and fragments to 200 characters (П13)", async () => {
    const { searchHistory } = await historyIn("UTC");
    const best = await conversation(
      [
        { text: "Какой ноутбук взять?" },
        {
          text: `${"суперкалифрагилистический ".repeat(20)}ноутбук ${"суперкалифрагилистический ".repeat(20)}`,
        },
        { text: "Ноутбук лёгкий" },
        { text: "Ноутбук дешёвый" },
      ],
      { title: "Ноутбук", summary: `Ноутбук: ${"ж".repeat(500)}` },
    );
    for (let index = 0; index < 5; index += 1) {
      await conversation([{ text: `Ноутбук ${index}` }]);
    }

    const found = unwrap(await searchHistory({ query: "ноутбук" }));

    expect(found.conversations).toHaveLength(5);
    const [first] = found.conversations;
    expect(first?.id).toBe(best.id);
    expect(first?.matches).toHaveLength(3);
    expect([...(first?.summary ?? "")].length).toBeLessThanOrEqual(300);
    expect(first?.matches.every((match) => [...match.text].length <= 200)).toBe(
      true,
    );
    expect(
      first?.matches.some(
        (match) => [...match.text].length === 200 && match.text.endsWith("…"),
      ),
    ).toBe(true);
  });

  it("answers a query of stop words «и в на» with nothing and no error (E7)", async () => {
    const { searchHistory } = await historyIn("UTC");
    await conversation([{ text: "и в на" }], {
      title: "и в на",
      summary: "и в на",
    });

    expect(unwrap(await searchHistory({ query: "и в на" }))).toEqual({
      conversations: [],
      outsideRange: false,
    });
  });
});

describe("readConversation", () => {
  it("reads the summary and the messages around a seq without tool calls, within 8000 characters", async () => {
    const { readConversation } = await historyIn("UTC");
    const long = (index: number) => `${index} `.padEnd(1000, "ж");
    const read = await conversation(
      [
        ...Array.from({ length: 30 }, (_, index) => ({ text: long(index) })),
        {
          text: "",
          role: "assistant" as const,
          parts: [
            {
              type: "tool-list_wallets" as const,
              toolCallId: "call_wallets",
              state: "output-available" as const,
              input: {},
              output: { secret: "вывод тула" },
            },
            { type: "text" as const, text: "Остаток 41 200 ARS" },
          ],
        },
      ],
      { title: "Длинный разговор", summary: "Сводка длинного разговора" },
    );
    const around = read.seqs[15] ?? 0;

    const result = unwrap(await readConversation(read.id, around));
    const tail = unwrap(await readConversation(read.id));

    if (!result || !tail) throw new Error("Разговор не прочитан");
    const size = [
      result.title,
      result.summary,
      ...result.messages.map((m) => m.text),
    ]
      .map((text) => [...(text ?? "")].length)
      .reduce((sum, length) => sum + length, 0);
    expect(size).toBeLessThanOrEqual(8000);
    expect(result.summary).toBe("Сводка длинного разговора");
    expect(result.messages.map((message) => message.seq)).toContain(around);
    expect(result.messages.map((message) => message.seq)).toEqual(
      [...result.messages.map((message) => message.seq)].sort((a, b) => a - b),
    );
    expect(JSON.stringify(tail)).not.toContain("вывод тула");
    expect(JSON.stringify(tail)).not.toContain("call_wallets");
    expect(tail.messages.at(-1)).toMatchObject({
      role: "assistant",
      text: "Остаток 41 200 ARS",
    });
  });

  it("reads the 20 messages nearest to aroundSeq", async () => {
    const { readConversation } = await historyIn("UTC");
    const read = await conversation(
      Array.from({ length: 30 }, (_, index) => ({ text: `Реплика ${index}` })),
    );

    const result = unwrap(await readConversation(read.id, read.seqs[15]));

    expect(result?.messages.map((message) => message.seq)).toEqual(
      read.seqs.slice(5, 25),
    );
  });

  it("answers null for a conversation that does not exist", async () => {
    const { readConversation } = await historyIn("UTC");

    expect(await readConversation(crypto.randomUUID())).toBeNull();
  });
});
