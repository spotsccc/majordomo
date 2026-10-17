import { zstdDecompressSync } from "node:zlib";
import { changes, conversations, core, entries, messages } from "@repo/db";
import { unwrap } from "@spotsccc/error-as-value";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  CODEX_URL,
  codexAnswer,
  heldCodexAnswer,
  signIn,
  signOut,
  urlOf,
} from "../chatgpt.test-utils";
import { db } from "../db";
import {
  addCoreFact,
  forgetEntry,
  removeCoreFact,
  saveEntry,
} from "./memory-store";
import { insertMessage, ownerTurn, resetMemory } from "./memory.test-utils";
import { processConversation } from "./process-conversation";

const HOUR = 3_600_000;

type Operation = {
  seq: number;
  id?: string;
  version?: number;
  kind: "person" | "preference" | "fact" | "plan";
  title: string;
  text: string;
  validUntil?: string;
  source: "owner" | "inferred";
};

const Request = z.object({
  instructions: z.string(),
  input: z.array(
    z.looseObject({
      role: z.string().optional(),
      content: z.array(z.looseObject({ text: z.string().optional() })),
    }),
  ),
});

const Prompt = z.object({
  summary: z.string().nullable(),
  entries: z.array(z.looseObject({ title: z.string(), text: z.string() })),
  messages: z.array(
    z.object({ seq: z.number(), role: z.string(), text: z.string() }),
  ),
});

function bodyOf(init: RequestInit | undefined): string {
  return init?.body instanceof Uint8Array
    ? zstdDecompressSync(init.body).toString()
    : String(init?.body);
}

function promptOf(body: string | undefined) {
  const request = Request.parse(JSON.parse(body ?? ""));
  const text = request.input.find((item) => item.role === "user")?.content[0]
    ?.text;
  return Prompt.parse(JSON.parse(text ?? ""));
}

function answer(operations: Operation[] = [], summary = "Сводка"): Response {
  return codexAnswer(
    JSON.stringify({ title: "Выбор ноутбука", summary, operations }),
  );
}

function model(reply: () => Response): string[] {
  const bodies: string[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (urlOf(input) !== CODEX_URL) {
        throw new Error(`Неожиданный запрос ${urlOf(input)}`);
      }
      bodies.push(bodyOf(init));
      return reply();
    },
  );
  return bodies;
}

/** Owner and agent take turns, the owner first. */
async function conversationOf(
  count: number,
  createdAt?: Date,
): Promise<{ id: string; messages: { id: string; seq: number }[] }> {
  const [conversation] = await db
    .insert(conversations)
    .values({
      channel: "telegram",
      externalId: `telegram:${crypto.randomUUID()}`,
    })
    .returning({ id: conversations.id });
  if (!conversation) throw new Error("Диалог не создан");
  const inserted = await db
    .insert(messages)
    .values(
      Array.from({ length: count }, (_, index) => ({
        conversationId: conversation.id,
        uiMessage: {
          id: crypto.randomUUID(),
          role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
          parts: [{ type: "text" as const, text: `Реплика ${index + 1}` }],
        },
        createdAt,
      })),
    )
    .returning({ id: messages.id, seq: messages.seq });
  return {
    id: conversation.id,
    messages: inserted.sort((a, b) => a.seq - b.seq),
  };
}

async function cursorOf(conversationId: string) {
  const [row] = await db
    .select({
      title: conversations.title,
      summary: conversations.summary,
      cursor: conversations.summaryThroughSeq,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  return row;
}

async function activeEntries() {
  return db
    .select({
      title: entries.title,
      text: entries.text,
      source: entries.source,
      sourceMessageId: entries.sourceMessageId,
      version: entries.version,
    })
    .from(entries)
    .where(eq(entries.status, "active"))
    .orderBy(asc(entries.title));
}

beforeEach(async () => {
  await resetMemory();
  await signIn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("processConversation", () => {
  it("takes 41 of 51 unprocessed messages and puts the cursor on the 41st; when the conversation closes, all 51 (П10)", async () => {
    const open = await conversationOf(51);
    const closed = await conversationOf(51);
    const bodies = model(() => answer());

    await processConversation(open.id, { whole: false });
    await processConversation(closed.id, { whole: true });

    expect(promptOf(bodies[0]).messages).toHaveLength(41);
    expect(await cursorOf(open.id)).toEqual({
      title: "Выбор ноутбука",
      summary: "Сводка",
      cursor: open.messages[40]?.seq,
    });
    expect(promptOf(bodies[1]).messages).toHaveLength(51);
    expect((await cursorOf(closed.id))?.cursor).toBe(closed.messages[50]?.seq);
  });

  it("writes an entry with its owner message as the source and a change of the extractor, and drops operations without an owner message of the part (П11)", async () => {
    const conversation = await conversationOf(4);
    const [first, answerSeq, third] = conversation.messages;
    if (!first || !answerSeq || !third) throw new Error("Мало сообщений");
    const nuts = {
      kind: "fact",
      title: "Аллергия на орехи",
      text: "у владельца",
      source: "owner",
    } as const;
    model(() =>
      answer([
        { ...nuts, seq: third.seq },
        { ...nuts, title: "Ответ бота", seq: answerSeq.seq },
        { ...nuts, title: "Чужая реплика", seq: 999_999 },
        {
          kind: "preference",
          title: "Десерты",
          text: "любит без орехов",
          source: "inferred",
          seq: first.seq,
        },
      ]),
    );

    await processConversation(conversation.id, { whole: true });

    expect(await activeEntries()).toEqual([
      {
        title: "Аллергия на орехи",
        text: "у владельца",
        source: "owner",
        sourceMessageId: third.id,
        version: 1,
      },
      {
        title: "Десерты",
        text: "любит без орехов",
        source: "inferred",
        sourceMessageId: first.id,
        version: 1,
      },
    ]);
    expect(
      await db
        .select({
          actor: changes.actor,
          action: changes.action,
          conversationId: changes.conversationId,
        })
        .from(changes),
    ).toEqual([
      { actor: "extractor", action: "create", conversationId: conversation.id },
      { actor: "extractor", action: "create", conversationId: conversation.id },
    ]);
  });

  it("writes an operation aimed at the core as an entry and leaves the core as it is (П2)", async () => {
    const conversation = await conversationOf(2);
    const [owner] = conversation.messages;
    model(() =>
      codexAnswer(
        JSON.stringify({
          title: "Указания",
          summary: "Владелец просил отвечать коротко",
          operations: [
            {
              seq: owner?.seq,
              section: "instructions",
              kind: "preference",
              title: "Ответы",
              text: "коротко, без списков",
              source: "owner",
            },
          ],
        }),
      ),
    );

    await processConversation(conversation.id, { whole: true });

    expect(await db.select().from(core)).toEqual([]);
    expect((await activeEntries()).map((entry) => entry.title)).toEqual([
      "Ответы",
    ]);
  });

  it("does not create «Маша», remembered in conversation A and forgotten later in conversation B, when A is processed (П21)", async () => {
    const a = await conversationOf(2, new Date(Date.now() - HOUR));
    const b = await ownerTurn("Запомни: Маша — жена");
    const masha = unwrap(
      await saveEntry({ kind: "person", title: "Маша", text: "жена" }, b),
    );
    unwrap(await forgetEntry(masha.id, "владелец попросил забыть", b));
    model(() =>
      answer([
        {
          seq: a.messages[0]?.seq ?? 0,
          kind: "person",
          title: "Маша",
          text: "жена",
          source: "owner",
        },
      ]),
    );

    await processConversation(a.id, { whole: true });

    expect(await activeEntries()).toEqual([]);
    expect((await cursorOf(a.id))?.cursor).toBe(a.messages[1]?.seq);
  });

  it("does not create «Аллергия» from conversation A when the core fact with it was removed later in conversation B (П21)", async () => {
    const a = await conversationOf(2, new Date(Date.now() - HOUR));
    const b = await ownerTurn("Запомни: аллергия на орехи");
    unwrap(
      await addCoreFact({ section: "profile", text: "Аллергия — на орехи" }, b),
    );
    unwrap(await removeCoreFact("Аллергия", "владелец попросил забыть", b));
    model(() =>
      answer([
        {
          seq: a.messages[0]?.seq ?? 0,
          kind: "fact",
          title: "Аллергия",
          text: "на орехи",
          source: "owner",
        },
      ]),
    );

    await processConversation(a.id, { whole: true });

    expect(await activeEntries()).toEqual([]);
    expect((await cursorOf(a.id))?.cursor).toBe(a.messages[1]?.seq);
  });

  it("does not create under another title what was taken from a message of conversation A and removed from the core later, and keeps the other messages (П21)", async () => {
    const a = await conversationOf(4, new Date(Date.now() - HOUR));
    const [said, , other] = a.messages;
    if (!said || !other) throw new Error("Мало сообщений");
    unwrap(
      await addCoreFact(
        { section: "profile", text: "Аллергия — на орехи" },
        { conversationId: a.id, messageId: said.id },
      ),
    );
    unwrap(
      await removeCoreFact(
        "Аллергия",
        "владелец попросил забыть",
        await ownerTurn("Забудь про аллергию"),
      ),
    );
    model(() =>
      answer([
        {
          seq: said.seq,
          kind: "fact",
          title: "Аллергия на орехи",
          text: "у владельца",
          source: "owner",
        },
        {
          seq: other.seq,
          kind: "preference",
          title: "Десерты",
          text: "любит панна-котту",
          source: "owner",
        },
      ]),
    );

    await processConversation(a.id, { whole: true });

    expect((await activeEntries()).map((entry) => entry.title)).toEqual([
      "Десерты",
    ]);
  });

  it("applies the operations after a refused one and moves the cursor", async () => {
    const conversation = await conversationOf(2);
    const seq = conversation.messages[0]?.seq ?? 0;
    const fact = (title: string): Operation => ({
      seq,
      kind: "fact",
      title,
      text: "у владельца",
      source: "owner",
    });
    model(() =>
      answer([
        fact("Аллергия на орехи"),
        fact("АЛЛЕРГИЯ НА ОРЕХИ"),
        fact("Непереносимость лактозы"),
      ]),
    );

    await processConversation(conversation.id, { whole: true });

    expect((await activeEntries()).map((entry) => entry.title)).toEqual([
      "Аллергия на орехи",
      "Непереносимость лактозы",
    ]);
    expect(await db.select().from(changes)).toHaveLength(2);
    expect((await cursorOf(conversation.id))?.cursor).toBe(
      conversation.messages[1]?.seq,
    );
  });

  it("sends the next run the summary of the previous one and only the messages after its cursor", async () => {
    const conversation = await conversationOf(4);
    let run = 0;
    const bodies = model(() => {
      run += 1;
      return answer([], `Сводка ${run}`);
    });
    await processConversation(conversation.id, { whole: true });
    await insertMessage(conversation.id, "user", "Беру MacBook Air");
    await insertMessage(conversation.id, "assistant", "Хороший выбор");

    await processConversation(conversation.id, { whole: true });

    const second = promptOf(bodies[1]);
    expect(second.summary).toBe("Сводка 1");
    expect(second.messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "Беру MacBook Air" },
      { role: "assistant", text: "Хороший выбор" },
    ]);
    expect((await cursorOf(conversation.id))?.summary).toBe("Сводка 2");
  });

  it("sends the JSON Schema of the answer and the active entries with their texts", async () => {
    const turn = await ownerTurn("Запомни: Маша — жена, любит пионы");
    unwrap(
      await saveEntry(
        { kind: "person", title: "Маша", text: "жена, любит пионы" },
        turn,
      ),
    );
    const conversation = await conversationOf(2);
    const bodies = model(() => answer());

    await processConversation(conversation.id, { whole: true });

    const request = Request.parse(JSON.parse(bodies[0] ?? ""));
    expect(request.instructions).toContain('"$schema"');
    expect(request.instructions).toContain('"operations"');
    expect(promptOf(bodies[0]).entries).toEqual([
      expect.objectContaining({ title: "Маша", text: "жена, любит пионы" }),
    ]);
  });

  it("keeps the summary and the operations of one run when two runs go at once (E1)", async () => {
    const conversation = await conversationOf(2);
    const held = [1, 2].map((run) =>
      heldCodexAnswer(
        JSON.stringify({
          title: "Выбор ноутбука",
          summary: `Сводка ${run}`,
          operations: [
            {
              seq: conversation.messages[0]?.seq ?? 0,
              kind: "fact",
              title: `Запись ${run}`,
              text: "у владельца",
              source: "owner",
            },
          ],
        }),
      ),
    );
    let onBothSent = () => {};
    const bothSent = new Promise<void>((resolve) => {
      onBothSent = resolve;
    });
    const bodies = model(() => {
      if (bodies.length === 2) onBothSent();
      const reply = held[bodies.length - 1];
      if (!reply) throw new Error("Лишний запрос к модели");
      return reply.response;
    });

    const runs = Promise.all([
      processConversation(conversation.id, { whole: true }),
      processConversation(conversation.id, { whole: true }),
    ]);
    await bothSent;
    for (const reply of held) reply.release();
    await runs;

    const run = (await cursorOf(conversation.id))?.summary?.slice(-1);
    expect(["1", "2"]).toContain(run);
    expect((await activeEntries()).map((entry) => entry.title)).toEqual([
      `Запись ${run}`,
    ]);
    expect(await db.select().from(changes)).toHaveLength(1);
  });

  it("applies nothing and keeps the cursor when a write fails between operations", async () => {
    const conversation = await conversationOf(2);
    const seq = conversation.messages[0]?.seq ?? 0;
    model(() =>
      answer([
        {
          seq,
          kind: "fact",
          title: "Аллергия на орехи",
          text: "у владельца",
          source: "owner",
        },
        {
          seq,
          kind: "person",
          title: "Петя",
          text: "друг\u0000",
          source: "owner",
        },
      ]),
    );

    await processConversation(conversation.id, { whole: true });

    expect(await activeEntries()).toEqual([]);
    expect(await db.select().from(changes)).toEqual([]);
    expect(await cursorOf(conversation.id)).toEqual({
      title: null,
      summary: null,
      cursor: null,
    });
  });

  it("writes nothing and keeps the cursor when the model does not answer in 120 s (E2)", async () => {
    const conversation = await conversationOf(2);
    let aborted: unknown;
    let onSent = () => {};
    const sent = new Promise<void>((resolve) => {
      onSent = resolve;
    });
    vi.stubGlobal(
      "fetch",
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        onSent();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = init.signal?.reason;
            reject(init.signal?.reason);
          });
        });
      },
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const run = processConversation(conversation.id, { whole: true });
    await sent;
    await vi.advanceTimersByTimeAsync(119_000);
    expect(aborted).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    await run;

    expect(aborted).toBeDefined();
    expect(await cursorOf(conversation.id)).toEqual({
      title: null,
      summary: null,
      cursor: null,
    });
  });

  it("applies nothing when the answer is not JSON of the schema (E3)", async () => {
    const conversation = await conversationOf(2);
    model(() => codexAnswer("Запомнил аллергию на орехи."));

    await processConversation(conversation.id, { whole: true });

    expect(await activeEntries()).toEqual([]);
    expect((await cursorOf(conversation.id))?.cursor).toBeNull();
  });

  it("applies nothing when the answer stops on the length limit before any text", async () => {
    const conversation = await conversationOf(2);
    model(
      () =>
        new Response(
          [
            { type: "response.created", response: { id: "resp_1" } },
            {
              type: "response.incomplete",
              response: {
                id: "resp_1",
                incomplete_details: { reason: "max_output_tokens" },
              },
            },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );

    await expect(
      processConversation(conversation.id, { whole: true }),
    ).resolves.toBeUndefined();

    expect((await cursorOf(conversation.id))?.cursor).toBeNull();
  });

  it("takes a tail of 450 messages in three runs of 200, 200 and 50, the cursor growing (П10)", async () => {
    const conversation = await conversationOf(450);
    const bodies = model(() => answer());
    const cursors: (number | null | undefined)[] = [];

    for (let run = 0; run < 3; run += 1) {
      await processConversation(conversation.id, { whole: true });
      cursors.push((await cursorOf(conversation.id))?.cursor);
    }

    expect(bodies.map((body) => promptOf(body).messages.length)).toEqual([
      200, 200, 50,
    ]);
    expect(cursors).toEqual(
      [199, 399, 449].map((index) => conversation.messages[index]?.seq),
    );
  });

  it("updates an entry of another conversation by its id and version (П4)", async () => {
    const other = await ownerTurn("Запомни: Маша — жена");
    const masha = unwrap(
      await saveEntry({ kind: "person", title: "Маша", text: "жена" }, other),
    );
    const conversation = await conversationOf(2);
    model(() =>
      answer([
        {
          seq: conversation.messages[0]?.seq ?? 0,
          id: masha.id,
          version: 1,
          kind: "person",
          title: "Маша",
          text: "жена, любит тюльпаны",
          source: "owner",
        },
      ]),
    );

    await processConversation(conversation.id, { whole: true });

    expect(await activeEntries()).toEqual([
      expect.objectContaining({
        title: "Маша",
        text: "жена, любит тюльпаны",
        version: 2,
      }),
    ]);
    expect(
      await db
        .select({
          actor: changes.actor,
          conversationId: changes.conversationId,
        })
        .from(changes)
        .where(eq(changes.action, "update")),
    ).toEqual([{ actor: "extractor", conversationId: conversation.id }]);
  });

  it("skips without a ChatGPT session, without asking the model or telling the owner (E4)", async () => {
    await signOut();
    const conversation = await conversationOf(2);
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      requests.push(urlOf(input));
      return new Response("{}", { status: 500 });
    });

    await processConversation(conversation.id, { whole: true });

    expect(requests).toEqual([]);
    expect((await cursorOf(conversation.id))?.cursor).toBeNull();
  });
});
