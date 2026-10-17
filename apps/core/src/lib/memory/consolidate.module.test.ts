import { zstdDecompressSync } from "node:zlib";
import {
  changes,
  conversations,
  core,
  entries,
  type EntryKind,
} from "@repo/db";
import { unwrap } from "@spotsccc/error-as-value";
import { asc, eq, ne, sql } from "drizzle-orm";
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
import { db, pool } from "../db";
import {
  FakeTelegram,
  OWNER_ID,
  resetChats,
} from "../telegram/telegram.test-utils";
import { consolidate, type Night } from "./consolidate";
import {
  addCoreFact,
  MemoryRefusal,
  mergeEntries,
  replaceCoreFact,
  saveEntry,
} from "./memory-store";
import { conversationOf, ownerTurn, waitingLocks } from "./memory.test-utils";

const HOUR = 3_600_000;

const DAY = 24 * HOUR;

type Answer = {
  merges?: { ids: string[]; text: string }[];
  toCore?: { id: string }[];
  toEntries?: { id: number; kind: EntryKind; title: string }[];
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

const NightPrompt = z.object({
  coreUsed: z.number(),
  core: z.array(z.looseObject({ id: z.number(), text: z.string() })),
  entries: z.array(
    z.looseObject({
      id: z.string(),
      kind: z.string(),
      title: z.string(),
      said: z.string(),
    }),
  ),
});

let telegram: FakeTelegram;
let nightBodies: string[];
let processingCalls: number;

function bodyOf(init: RequestInit | undefined): string {
  return init?.body instanceof Uint8Array
    ? zstdDecompressSync(init.body).toString()
    : String(init?.body);
}

function nightPromptOf(body: string | undefined) {
  const request = Request.parse(JSON.parse(body ?? ""));
  const text = request.input.find((item) => item.role === "user")?.content[0]
    ?.text;
  return NightPrompt.parse(JSON.parse(text ?? ""));
}

function tidied(answer: Answer = {}): Response {
  return codexAnswer(
    JSON.stringify({ merges: [], toCore: [], toEntries: [], ...answer }),
  );
}

function processed(): Response {
  return codexAnswer(
    JSON.stringify({ title: "Разговор", summary: "Сводка", operations: [] }),
  );
}

/**
 * The processing of a conversation and the night pass both ask chatgpt.com; the night's request
 * carries `merges` in the schema of its answer.
 */
function network({
  night = () => tidied(),
  processing = () => processed(),
  botApi = (url, init) => telegram.answer(url, init),
}: {
  night?: () => Response;
  processing?: (init?: RequestInit) => Response | Promise<Response>;
  botApi?: (url: string, init?: RequestInit) => Response;
} = {}): void {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (telegram.handles(url)) return botApi(url, init);
      if (url !== CODEX_URL) throw new Error(`Неожиданный запрос ${url}`);
      const body = bodyOf(init);
      if (Request.parse(JSON.parse(body)).instructions.includes('"merges"')) {
        nightBodies.push(body);
        return night();
      }
      processingCalls += 1;
      return processing(init);
    },
  );
}

function heldNight(answer: Answer): {
  asked: Promise<void>;
  release: () => void;
} {
  const held = heldCodexAnswer(
    JSON.stringify({ merges: [], toCore: [], toEntries: [], ...answer }),
  );
  let onAsked = () => {};
  const asked = new Promise<void>((resolve) => {
    onAsked = resolve;
  });
  network({
    night: () => {
      onAsked();
      return held.response;
    },
  });
  return { asked, release: held.release };
}

async function remember(
  title: string,
  text: string,
  {
    kind = "fact",
    said,
    validUntil,
  }: { kind?: EntryKind; said?: Date; validUntil?: Date } = {},
) {
  const turn = await ownerTurn(`Запомни: ${title} — ${text}`, said);
  return {
    ...unwrap(await saveEntry({ kind, title, text, validUntil }, turn)),
    turn,
  };
}

async function extracted(title: string, text: string): Promise<void> {
  const turn = await ownerTurn(`${title} — ${text}`);
  await db.transaction(async (tx) => {
    unwrap(
      await saveEntry({ kind: "fact", title, text }, turn, {
        tx,
        source: "owner",
      }),
    );
  });
}

async function fillCore(): Promise<void> {
  const turn = await ownerTurn("Запомни всё это");
  for (let index = 0; index < 10; index += 1) {
    unwrap(
      await addCoreFact(
        { section: "profile", text: String(index).padEnd(299, "я") },
        turn,
      ),
    );
  }
}

async function entriesNow() {
  return db
    .select({
      id: entries.id,
      title: entries.title,
      text: entries.text,
      status: entries.status,
      supersededBy: entries.supersededBy,
    })
    .from(entries)
    .orderBy(asc(entries.title));
}

async function coreNow() {
  return db
    .select({
      id: core.id,
      section: core.section,
      text: core.text,
      status: core.status,
    })
    .from(core)
    .orderBy(asc(core.id));
}

async function backgroundChanges() {
  return db
    .select({
      actor: changes.actor,
      action: changes.action,
      entryId: changes.entryId,
      coreId: changes.coreId,
      reportedAt: changes.reportedAt,
    })
    .from(changes)
    .where(ne(changes.actor, "agent"))
    .orderBy(asc(changes.at), asc(changes.action));
}

async function cursorOf(conversationId: string) {
  const [row] = await db
    .select({ cursor: conversations.summaryThroughSeq })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  return row?.cursor;
}

function report(...lines: string[]): string {
  return [
    "Ночью обновил память:",
    ...lines,
    "Посмотреть — /memory, вернуть — напиши «верни …».",
  ].join("\n");
}

/** Chat SDK and state-pg remember a connection that worked, so a check of a first connection needs its own module graph. */
async function freshConsolidate(): Promise<typeof consolidate> {
  vi.resetModules();
  return (await import("./consolidate")).consolidate;
}

beforeEach(async () => {
  await resetChats();
  await signIn();
  telegram = new FakeTelegram();
  nightBodies = [];
  processingCalls = 0;
});

afterEach(() => {
  vi.useRealTimers();
  expect(telegram.unhandled).toEqual([]);
});

describe("consolidate", () => {
  it("keeps the newer of «Ноутбук» and «Выбор ноутбука» with the merged text and archives the other pointing at it (П12)", async () => {
    const older = await remember("Выбор ноутбука", "MacBook Air или ThinkPad", {
      said: new Date(Date.now() - 2 * DAY),
    });
    const newer = await remember("Ноутбук", "выбран MacBook Air M4", {
      said: new Date(Date.now() - DAY),
    });
    network({
      night: () =>
        tidied({
          merges: [
            {
              ids: [older.id, newer.id],
              text: "выбран MacBook Air M4, сравнивали с ThinkPad",
            },
          ],
        }),
    });

    const night = await consolidate();

    expect(night).toMatchObject({ merged: 1, failed: 0 });
    expect(night.refused).toEqual({});
    expect(await entriesNow()).toEqual([
      {
        id: older.id,
        title: "Выбор ноутбука",
        text: "MacBook Air или ThinkPad",
        status: "archived",
        supersededBy: newer.id,
      },
      {
        id: newer.id,
        title: "Ноутбук",
        text: "выбран MacBook Air M4, сравнивали с ThinkPad",
        status: "active",
        supersededBy: null,
      },
    ]);
    expect(
      (await backgroundChanges()).map(({ actor, action, entryId }) => ({
        actor,
        action,
        entryId,
      })),
    ).toEqual(
      expect.arrayContaining([
        { actor: "consolidator", action: "merge", entryId: older.id },
        { actor: "consolidator", action: "merge", entryId: newer.id },
      ]),
    );
    expect(telegram.textsIn(OWNER_ID)).toEqual([
      report("= «Ноутбук» ← «Выбор ноутбука»"),
    ]);
  });

  it("keeps the entry the owner said later when two entries contradict, though the other one was written later (П12)", async () => {
    const later = await remember("Кофе по утрам", "без сахара", {
      said: new Date(Date.now() - DAY),
    });
    const earlier = await remember("Кофе", "с сахаром", {
      said: new Date(Date.now() - 3 * DAY),
    });
    network({
      night: () =>
        tidied({
          merges: [{ ids: [earlier.id, later.id], text: "без сахара" }],
        }),
    });

    await consolidate();

    expect(await entriesNow()).toEqual([
      {
        id: earlier.id,
        title: "Кофе",
        text: "с сахаром",
        status: "archived",
        supersededBy: later.id,
      },
      {
        id: later.id,
        title: "Кофе по утрам",
        text: "без сахара",
        status: "active",
        supersededBy: null,
      },
    ]);
    const said = new Map(
      nightPromptOf(nightBodies[0]).entries.map((entry) => [
        entry.title,
        entry.said,
      ]),
    );
    expect(said.get("Кофе")?.slice(0, 10)).toBe(
      new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10),
    );
    expect(said.get("Кофе по утрам")?.slice(0, 10)).toBe(
      new Date(Date.now() - DAY).toISOString().slice(0, 10),
    );
  });

  it("refuses to merge an owner's entry when nothing is left to replace it (П12)", async () => {
    const masha = await remember("Маша", "жена", { kind: "person" });
    network({
      night: () =>
        tidied({
          merges: [{ ids: [masha.id, crypto.randomUUID()], text: "жена" }],
        }),
    });

    const night = await consolidate();

    expect(night).toMatchObject({ merged: 0 });
    expect(night.refused).toEqual({ validation: 1 });
    expect(await entriesNow()).toEqual([
      {
        id: masha.id,
        title: "Маша",
        text: "жена",
        status: "active",
        supersededBy: null,
      },
    ]);
    expect(await backgroundChanges()).toEqual([]);
  });

  it("archives an entry and a core fact whose valid_until was yesterday and keeps the one valid until tomorrow (П7)", async () => {
    const yesterday = new Date(Date.now() - DAY);
    await remember("Мадрид", "командировка", {
      kind: "plan",
      validUntil: yesterday,
    });
    await remember("Лиссабон", "отпуск", {
      kind: "plan",
      validUntil: new Date(Date.now() + DAY),
    });
    unwrap(
      await addCoreFact(
        { section: "profile", text: "Ищет работу", validUntil: yesterday },
        await ownerTurn("Пока ищу работу"),
      ),
    );
    network();

    const night = await consolidate();

    expect(night.expired).toBe(2);
    expect(
      (await entriesNow()).map(({ title, status }) => ({ title, status })),
    ).toEqual([
      { title: "Лиссабон", status: "active" },
      { title: "Мадрид", status: "archived" },
    ]);
    expect((await coreNow()).map((fact) => fact.status)).toEqual(["archived"]);
    expect(
      (await backgroundChanges()).map(({ actor, action }) => ({
        actor,
        action,
      })),
    ).toEqual([
      { actor: "consolidator", action: "archive" },
      { actor: "consolidator", action: "archive" },
    ]);
    expect(telegram.textsIn(OWNER_ID)).toEqual([
      report("− Ищет работу: срок прошёл", "− Мадрид: срок прошёл"),
    ]);
  });

  it("moves «Маша» to the core as «Маша — жена…» with the same source, archives the entry and writes a move for each side (П17)", async () => {
    const masha = await remember("Маша", "жена, день рождения 14 марта", {
      kind: "person",
    });
    network({ night: () => tidied({ toCore: [{ id: masha.id }] }) });

    const night = await consolidate();

    expect(night).toMatchObject({ moved: 1 });
    expect(night.refused).toEqual({});
    expect(
      (await entriesNow()).map(({ title, status }) => ({ title, status })),
    ).toEqual([{ title: "Маша", status: "archived" }]);
    const [fact, ...others] = await db.select().from(core);
    expect(others).toEqual([]);
    expect(fact).toMatchObject({
      section: "profile",
      text: "Маша — жена, день рождения 14 марта",
      status: "active",
      source: "owner",
      sourceMessageId: masha.turn.messageId,
      validUntil: null,
    });
    expect(
      (await backgroundChanges()).map(({ actor, action, entryId, coreId }) => ({
        actor,
        action,
        entryId,
        coreId,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          actor: "consolidator",
          action: "move",
          entryId: masha.id,
          coreId: null,
        },
        {
          actor: "consolidator",
          action: "move",
          entryId: null,
          coreId: fact?.id,
        },
      ]),
    );
    expect(telegram.textsIn(OWNER_ID)).toEqual([
      report("↑ в ядро: Маша — жена, день рождения 14 марта"),
    ]);
  });

  it("merges «Мария» into «Маша» and moves the merged «Маша» to the core in the same pass (S7)", async () => {
    const maria = await remember("Мария", "любит пионы", {
      kind: "person",
      said: new Date(Date.now() - 2 * DAY),
    });
    const masha = await remember("Маша", "жена, день рождения 14 марта", {
      kind: "person",
      said: new Date(Date.now() - DAY),
    });
    network({
      night: () =>
        tidied({
          merges: [
            {
              ids: [maria.id, masha.id],
              text: "жена, день рождения 14 марта, любит пионы",
            },
          ],
          toCore: [{ id: masha.id }],
        }),
    });

    const night = await consolidate();

    expect(night).toMatchObject({ merged: 1, moved: 1 });
    expect(night.refused).toEqual({});
    expect((await coreNow()).map((fact) => fact.text)).toEqual([
      "Маша — жена, день рождения 14 марта, любит пионы",
    ]);
    expect(
      (await entriesNow()).map(({ title, status }) => ({ title, status })),
    ).toEqual([
      { title: "Мария", status: "archived" },
      { title: "Маша", status: "archived" },
    ]);
    expect(telegram.textsIn(OWNER_ID)).toEqual([
      report(
        "= «Маша» ← «Мария»",
        "↑ в ядро: Маша — жена, день рождения 14 марта, любит пионы",
      ),
    ]);
  });

  it("moves a core fact to an entry with the kind and title the model gave, keeping its source (П17)", async () => {
    const turn = await ownerTurn("Запомни: машина — Škoda Octavia 2019");
    unwrap(
      await addCoreFact(
        { section: "profile", text: "Машина — Škoda Octavia 2019" },
        turn,
      ),
    );
    const [fact] = await coreNow();
    network({
      night: () =>
        tidied({
          toEntries: [{ id: fact?.id ?? 0, kind: "fact", title: "Машина" }],
        }),
    });

    const night = await consolidate();

    expect(night.moved).toBe(1);
    expect((await coreNow()).map((row) => row.status)).toEqual(["archived"]);
    expect(
      await db
        .select({
          kind: entries.kind,
          title: entries.title,
          text: entries.text,
          source: entries.source,
          sourceMessageId: entries.sourceMessageId,
        })
        .from(entries),
    ).toEqual([
      {
        kind: "fact",
        title: "Машина",
        text: "Машина — Škoda Octavia 2019",
        source: "owner",
        sourceMessageId: turn.messageId,
      },
    ]);
    expect(telegram.textsIn(OWNER_ID)).toEqual([
      report("↓ из ядра в записи: Машина — Škoda Octavia 2019"),
    ]);
  });

  it("lets through one of core_add in a turn and a move to the core that wait for the lock of the core at 2990 of 3000 characters; the other gets core_full (П5)", async () => {
    await fillCore();
    const me = await remember("Я", "Иван");
    const wife = await ownerTurn("Запомни: жена Маша");
    const { asked, release } = heldNight({ toCore: [{ id: me.id }] });
    const run = consolidate();
    await asked;
    const holder = await pool.connect();
    let night: Night;
    let added: Awaited<ReturnType<typeof addCoreFact>>;
    try {
      await holder.query("begin");
      await holder.query(
        "select pg_advisory_xact_lock(hashtext('memory.core'::text))",
      );
      release();
      await waitingLocks(1);
      const adding = addCoreFact(
        { section: "profile", text: "Жена Маша" },
        wife,
      );
      await waitingLocks(2);
      await holder.query("commit");
      [night, added] = await Promise.all([run, adding]);
    } finally {
      await holder.query("rollback");
      holder.release();
    }

    const outcome =
      added instanceof MemoryRefusal
        ? `ход: ${added.refusal.code}, ночь перенесла ${night.moved}`
        : `ход записал, ночь: ${JSON.stringify(night.refused)}`;
    expect([
      "ход: core_full, ночь перенесла 1",
      'ход записал, ночь: {"core_full":1}',
    ]).toContain(outcome);
    const active = (await coreNow()).filter((fact) => fact.status === "active");
    expect(active.reduce((sum, fact) => sum + fact.text.length, 0)).toBe(
      2990 + (added instanceof MemoryRefusal ? "Я — Иван" : "Жена Маша").length,
    );
  });

  it("refuses a move to the core past 3000 characters with core_full and changes nothing (П5)", async () => {
    await fillCore();
    const masha = await remember("Маша", "жена", { kind: "person" });
    network({ night: () => tidied({ toCore: [{ id: masha.id }] }) });

    const night = await consolidate();

    expect(night).toMatchObject({ moved: 0 });
    expect(night.refused).toEqual({ core_full: 1 });
    expect(
      (await entriesNow()).map(({ title, status }) => ({ title, status })),
    ).toEqual([{ title: "Маша", status: "active" }]);
    expect(await coreNow()).toHaveLength(10);
    expect(await backgroundChanges()).toEqual([]);
  });

  it("refuses with conflict a move of a core fact that a turn changed after the night read it, and keeps the edit (П4)", async () => {
    unwrap(
      await addCoreFact(
        { section: "profile", text: "Машина — Škoda Octavia 2019" },
        await ownerTurn("Запомни: машина — Škoda Octavia 2019"),
      ),
    );
    const [fact] = await coreNow();
    const { asked, release } = heldNight({
      toEntries: [{ id: fact?.id ?? 0, kind: "fact", title: "Машина" }],
    });

    const run = consolidate();
    await asked;
    unwrap(
      await replaceCoreFact(
        "Octavia 2019",
        { text: "Машина — Škoda Kodiaq 2024" },
        await ownerTurn("Я купил Kodiaq"),
      ),
    );
    release();
    const night = await run;

    expect(night).toMatchObject({ moved: 0 });
    expect(night.refused).toEqual({ conflict: 1 });
    expect(await coreNow()).toEqual([
      {
        id: fact?.id,
        section: "profile",
        text: "Машина — Škoda Kodiaq 2024",
        status: "active",
      },
    ]);
    expect(await entriesNow()).toEqual([]);
  });

  it("refuses with conflict a merge and a move to the core of entries a turn changed after the night read them, and keeps the edits (П4)", async () => {
    const older = await remember("Выбор ноутбука", "MacBook Air или ThinkPad", {
      said: new Date(Date.now() - DAY),
    });
    const newer = await remember("Ноутбук", "выбран MacBook Air M4");
    const masha = await remember("Маша", "жена", { kind: "person" });
    const { asked, release } = heldNight({
      merges: [{ ids: [older.id, newer.id], text: "MacBook Air M4" }],
      toCore: [{ id: masha.id }],
    });

    const run = consolidate();
    await asked;
    const edit = await ownerTurn("Нет, взял ThinkPad; Маша любит пионы");
    unwrap(
      await saveEntry(
        {
          id: newer.id,
          version: newer.version,
          kind: "fact",
          title: "Ноутбук",
          text: "выбран ThinkPad X1",
        },
        edit,
      ),
    );
    unwrap(
      await saveEntry(
        {
          id: masha.id,
          version: masha.version,
          kind: "person",
          title: "Маша",
          text: "жена, любит пионы",
        },
        edit,
      ),
    );
    release();
    const night = await run;

    expect(night).toMatchObject({ merged: 0, moved: 0 });
    expect(night.refused).toEqual({ conflict: 2 });
    expect(
      (await entriesNow()).map(({ title, text, status }) => ({
        title,
        text,
        status,
      })),
    ).toEqual([
      {
        title: "Выбор ноутбука",
        text: "MacBook Air или ThinkPad",
        status: "active",
      },
      { title: "Маша", text: "жена, любит пионы", status: "active" },
      { title: "Ноутбук", text: "выбран ThinkPad X1", status: "active" },
    ]);
    expect(await coreNow()).toEqual([]);
    expect(await backgroundChanges()).toEqual([]);
  });

  it("rolls a move back whole when its last write fails, in both directions (П17)", async () => {
    const masha = await remember("Маша", "жена", { kind: "person" });
    unwrap(
      await addCoreFact(
        { section: "profile", text: "Машина — Škoda Octavia 2019" },
        await ownerTurn("Запомни: машина — Škoda Octavia 2019"),
      ),
    );
    const [fact] = await coreNow();
    network({
      night: () =>
        tidied({
          toCore: [{ id: masha.id }],
          toEntries: [{ id: fact?.id ?? 0, kind: "fact", title: "Машина" }],
        }),
    });
    await db.execute(
      sql`ALTER TABLE memory.changes ADD CONSTRAINT changes_no_move_check CHECK (action <> 'move')`,
    );
    let night: Night;
    try {
      night = await consolidate();
    } finally {
      await db.execute(
        sql`ALTER TABLE memory.changes DROP CONSTRAINT changes_no_move_check`,
      );
    }

    expect(night).toMatchObject({ moved: 0, failed: 2 });
    expect(
      (await entriesNow()).map(({ title, status }) => ({ title, status })),
    ).toEqual([{ title: "Маша", status: "active" }]);
    expect(await coreNow()).toEqual([
      {
        id: fact?.id,
        section: "profile",
        text: "Машина — Škoda Octavia 2019",
        status: "active",
      },
    ]);
    expect(await backgroundChanges()).toEqual([]);
  });

  it("does not show «Указания» to the model and refuses to move one of them out of the core (П2)", async () => {
    const turn = await ownerTurn("Всегда отвечай коротко");
    unwrap(
      await addCoreFact(
        { section: "instructions", text: "Отвечай коротко, без списков" },
        turn,
      ),
    );
    unwrap(
      await addCoreFact(
        { section: "profile", text: "Иван, живёт в Белграде" },
        turn,
      ),
    );
    const [instruction] = await coreNow();
    network({
      night: () =>
        tidied({
          toEntries: [
            { id: instruction?.id ?? 0, kind: "preference", title: "Ответы" },
          ],
        }),
    });

    const night = await consolidate();

    expect(night).toMatchObject({ moved: 0 });
    expect(night.refused).toEqual({ validation: 1 });
    expect(nightPromptOf(nightBodies[0]).core.map((fact) => fact.text)).toEqual(
      ["Иван, живёт в Белграде"],
    );
    expect(
      (await coreNow()).map(({ section, status }) => [section, status]),
    ).toEqual([
      ["instructions", "active"],
      ["profile", "active"],
    ]);
    expect(await entriesNow()).toEqual([]);
  });

  it("processes the tail of a closed conversation whole and of an hour-quiet open one but its last 10 messages, and leaves an open one in use (П10)", async () => {
    const closed = await conversationOf(250, { closed: true });
    const quiet = await conversationOf(15, {
      createdAt: new Date(Date.now() - 2 * HOUR),
    });
    const busy = await conversationOf(15);
    network();

    const night = await consolidate();

    expect(night.conversations).toBe(2);
    expect(processingCalls).toBe(3);
    expect(await cursorOf(closed.id)).toBe(closed.messages[249]?.seq);
    expect(await cursorOf(quiet.id)).toBe(quiet.messages[4]?.seq);
    expect(await cursorOf(busy.id)).toBeNull();
  });

  it("asks the model one kind at a time and warns in the result when the entries hold 160 000 characters (E6)", async () => {
    const turn = await ownerTurn("Запомни много");
    const kinds: EntryKind[] = ["person", "preference", "fact", "plan"];
    await db.insert(entries).values(
      kinds.flatMap((kind) =>
        Array.from({ length: 112 }, (_, index) => ({
          kind,
          title: `${kind} ${index} `.padEnd(60, "ы"),
          text: "т".repeat(300),
          source: "owner" as const,
          sourceMessageId: turn.messageId,
          validUntil: kind === "plan" ? new Date(Date.now() + DAY) : null,
        })),
      ),
    );
    network();

    const night = await consolidate();

    expect(
      nightBodies.map((body) => [
        ...new Set(nightPromptOf(body).entries.map((entry) => entry.kind)),
      ]),
    ).toEqual([["person"], ["preference"], ["fact"], ["plan"]]);
    expect(
      nightBodies.map((body) => nightPromptOf(body).entries.length),
    ).toEqual([112, 112, 112, 112]);
    expect(night.warnings).toEqual([
      "Записи — 161280 символов, больше 150000: дубли искались только внутри вида",
    ]);
  });

  it("changes nothing and sends no report on a second run with the same answers (E5)", async () => {
    const older = await remember("Выбор ноутбука", "MacBook Air или ThinkPad", {
      said: new Date(Date.now() - DAY),
    });
    const newer = await remember("Ноутбук", "выбран MacBook Air M4");
    network({
      night: () =>
        tidied({
          merges: [{ ids: [older.id, newer.id], text: "MacBook Air M4" }],
        }),
    });
    await consolidate();
    const afterFirst = await db.select().from(changes).orderBy(asc(changes.id));
    const entriesAfterFirst = await entriesNow();

    const second = await consolidate();

    expect(second).toMatchObject({ merged: 0, moved: 0, reported: 0 });
    expect(await db.select().from(changes).orderBy(asc(changes.id))).toEqual(
      afterFirst,
    );
    expect(await entriesNow()).toEqual(entriesAfterFirst);
    expect(telegram.textsIn(OWNER_ID)).toHaveLength(1);
  });

  it("sends one report when two runs go at once (E5)", async () => {
    const older = await remember("Выбор ноутбука", "MacBook Air или ThinkPad", {
      said: new Date(Date.now() - DAY),
    });
    const newer = await remember("Ноутбук", "выбран MacBook Air M4");
    network({
      night: () =>
        tidied({
          merges: [{ ids: [older.id, newer.id], text: "MacBook Air M4" }],
        }),
    });

    const nights = await Promise.all([consolidate(), consolidate()]);

    expect(nights.map((night) => night.merged).sort()).toEqual([0, 1]);
    expect(telegram.textsIn(OWNER_ID)).toEqual([
      report("= «Ноутбук» ← «Выбор ноутбука»"),
    ]);
    expect(
      (await backgroundChanges()).every((change) => change.reportedAt !== null),
    ).toBe(true);
  });

  it("takes the mark off when the Bot API refuses the report, and the next run sends it (П14)", async () => {
    await extracted("Аллергия на орехи", "у владельца");
    network({
      botApi: (url, init) =>
        url.endsWith("/sendMessage")
          ? Response.json(
              {
                ok: false,
                error_code: 403,
                description: "Forbidden: bot was blocked by the user",
              },
              { status: 403 },
            )
          : telegram.answer(url, init),
    });

    const refused = await consolidate();

    expect(refused).toMatchObject({ reported: 0, failed: 1 });
    expect(telegram.textsIn(OWNER_ID)).toEqual([]);
    expect(
      (await backgroundChanges()).map((change) => change.reportedAt),
    ).toEqual([null]);

    network();
    const next = await consolidate();

    expect(next).toMatchObject({ reported: 1, failed: 0 });
    expect(telegram.textsIn(OWNER_ID)).toEqual([
      report("+ Аллергия на орехи — у владельца"),
    ]);
  });

  it("sends the report once from an instance that has had no webhook, post does not throw and the mark stays (E15)", async () => {
    await extracted("Аллергия на орехи", "у владельца");
    network();

    const night = await (await freshConsolidate())();

    expect(night).toMatchObject({ reported: 1, failed: 0 });
    expect(telegram.textsIn(OWNER_ID)).toEqual([
      report("+ Аллергия на орехи — у владельца"),
    ]);
    const [change] = await backgroundChanges();
    expect(change?.reportedAt).toBeInstanceOf(Date);
  });

  it("sends no report while initialize() fails on a chat_state_locks without expires_at, and one report once the table is back (E15)", async () => {
    await extracted("Аллергия на орехи", "у владельца");
    network();
    await db.execute(sql`DROP TABLE IF EXISTS chat_state_locks`);
    await db.execute(sql`
      CREATE TABLE chat_state_locks (
        key_prefix text NOT NULL,
        thread_id text NOT NULL,
        token text NOT NULL,
        PRIMARY KEY (key_prefix, thread_id)
      )`);
    let broken: Awaited<ReturnType<typeof consolidate>>;
    try {
      broken = await (await freshConsolidate())();
    } finally {
      await db.execute(sql`DROP TABLE chat_state_locks`);
    }
    const sentWhileBroken = telegram.textsIn(OWNER_ID);
    const markWhileBroken = (await backgroundChanges()).map(
      (change) => change.reportedAt,
    );

    const restored = await (await freshConsolidate())();

    expect(broken).toMatchObject({ reported: 0, failed: 1 });
    expect(sentWhileBroken).toEqual([]);
    expect(markWhileBroken).toEqual([null]);
    expect(restored).toMatchObject({ reported: 1, failed: 0 });
    expect(telegram.textsIn(OWNER_ID)).toEqual([
      report("+ Аллергия на орехи — у владельца"),
    ]);
  });

  it("stops at the 240 s budget and leaves the rest of the tails, the archive by term and the request of the night to the next night (E6)", async () => {
    await remember("Ноутбук", "выбран MacBook Air M4");
    await remember("Мадрид", "командировка", {
      kind: "plan",
      validUntil: new Date(Date.now() - DAY),
    });
    const done = await conversationOf(4, { closed: true });
    const slow = await conversationOf(4, { closed: true });
    const later = await conversationOf(4, { closed: true });
    let onSlowAsked = () => {};
    const slowAsked = new Promise<void>((resolve) => {
      onSlowAsked = resolve;
    });
    network({
      processing: (init) => {
        if (processingCalls === 1) return processed();
        onSlowAsked();
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(signal.reason);
          signal?.addEventListener("abort", () => reject(signal.reason));
        });
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const run = consolidate();
    await slowAsked;
    await vi.advanceTimersByTimeAsync(240_000);
    const night = await run;
    vi.useRealTimers();

    expect(night).toMatchObject({
      conversations: 1,
      expired: 0,
      unfinished: true,
    });
    expect(
      (await entriesNow()).map(({ title, status }) => ({ title, status })),
    ).toEqual([
      { title: "Мадрид", status: "active" },
      { title: "Ноутбук", status: "active" },
    ]);
    expect(await cursorOf(done.id)).toBe(done.messages[3]?.seq);
    expect(await cursorOf(slow.id)).toBeNull();
    expect(await cursorOf(later.id)).toBeNull();
    expect(nightBodies).toEqual([]);

    network();
    const next = await consolidate();

    expect(next).toMatchObject({
      conversations: 2,
      expired: 1,
      unfinished: false,
    });
    expect(await cursorOf(slow.id)).toBe(slow.messages[3]?.seq);
    expect(await cursorOf(later.id)).toBe(later.messages[3]?.seq);
    expect(nightBodies).toHaveLength(1);
  });

  it("finishes the operation under way at the 240 s budget and starts no other one (E6)", async () => {
    const older = await remember("Выбор ноутбука", "MacBook Air или ThinkPad", {
      said: new Date(Date.now() - DAY),
    });
    const newer = await remember("Ноутбук", "выбран MacBook Air M4");
    const masha = await remember("Маша", "жена", { kind: "person" });
    unwrap(
      await addCoreFact(
        { section: "profile", text: "Машина — Škoda Octavia 2019" },
        await ownerTurn("Запомни: машина — Škoda Octavia 2019"),
      ),
    );
    const [fact] = await coreNow();
    const { asked, release } = heldNight({
      merges: [{ ids: [older.id, newer.id], text: "MacBook Air M4" }],
      toCore: [{ id: masha.id }],
      toEntries: [{ id: fact?.id ?? 0, kind: "fact", title: "Машина" }],
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const run = consolidate();
    await asked;
    const holder = await pool.connect();
    let night: Night;
    try {
      await holder.query("begin");
      await holder.query(
        "select pg_advisory_xact_lock(hashtext('memory.entries'::text))",
      );
      release();
      await waitingLocks(1);
      await vi.advanceTimersByTimeAsync(240_000);
      await holder.query("commit");
      night = await run;
    } finally {
      await holder.query("rollback");
      holder.release();
    }

    expect(night).toMatchObject({ merged: 1, moved: 0, unfinished: true });
    expect(
      (await entriesNow()).map(({ title, status }) => ({ title, status })),
    ).toEqual([
      { title: "Выбор ноутбука", status: "archived" },
      { title: "Маша", status: "active" },
      { title: "Ноутбук", status: "active" },
    ]);
    expect((await coreNow()).map((row) => row.status)).toEqual(["active"]);
  });

  it("refuses with conflict a second group of the answer that shares the kept entry of the first, though two other entries are left in it, and merges nothing else (П12)", async () => {
    const masha = await remember("Маша", "жена", { kind: "person" });
    const maria = await remember("Мария", "любит пионы", {
      kind: "person",
      said: new Date(Date.now() - DAY),
    });
    const ivanova = await remember("Маша Иванова", "день рождения 14 марта", {
      kind: "person",
      said: new Date(Date.now() - 2 * DAY),
    });
    const wife = await remember("Жена", "работает в банке", {
      kind: "person",
      said: new Date(Date.now() - 3 * DAY),
    });
    network({
      night: () =>
        tidied({
          merges: [
            { ids: [masha.id, maria.id], text: "жена, любит пионы" },
            {
              ids: [masha.id, ivanova.id, wife.id],
              text: "жена, день рождения 14 марта, работает в банке",
            },
          ],
        }),
    });

    const night = await consolidate();

    expect(night).toMatchObject({ merged: 1 });
    expect(night.refused).toEqual({ conflict: 1 });
    expect(
      (await entriesNow()).map(({ title, text, status }) => ({
        title,
        text,
        status,
      })),
    ).toEqual([
      { title: "Жена", text: "работает в банке", status: "active" },
      { title: "Мария", text: "любит пионы", status: "archived" },
      { title: "Маша", text: "жена, любит пионы", status: "active" },
      {
        title: "Маша Иванова",
        text: "день рождения 14 марта",
        status: "active",
      },
    ]);
  });

  it("refuses with conflict a group that names an entry of a merge refused earlier in the answer, and changes nothing (П12)", async () => {
    const masha = await remember("Маша", "жена", { kind: "person" });
    const ivanova = await remember("Маша Иванова", "день рождения 14 марта", {
      kind: "person",
      said: new Date(Date.now() - DAY),
    });
    const wife = await remember("Жена", "работает в банке", {
      kind: "person",
      said: new Date(Date.now() - 2 * DAY),
    });
    network({
      night: () =>
        tidied({
          merges: [
            { ids: [masha.id, crypto.randomUUID()], text: "жена" },
            {
              ids: [masha.id, ivanova.id, wife.id],
              text: "жена, день рождения 14 марта, работает в банке",
            },
          ],
        }),
    });
    const before = await entriesNow();

    const night = await consolidate();

    expect(night).toMatchObject({ merged: 0 });
    expect(night.refused).toEqual({ validation: 1, conflict: 1 });
    expect(await entriesNow()).toEqual(before);
    expect(
      (await backgroundChanges()).filter((change) => change.action === "merge"),
    ).toEqual([]);
  });

  it("aborts the request of the night at the 240 s budget and writes nothing (E6)", async () => {
    await remember("Ноутбук", "выбран MacBook Air M4");
    let aborted: unknown;
    let onAsked = () => {};
    const asked = new Promise<void>((resolve) => {
      onAsked = resolve;
    });
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (telegram.handles(url)) return telegram.answer(url, init);
        nightBodies.push(bodyOf(init));
        onAsked();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = init.signal?.reason;
            reject(init.signal?.reason);
          });
        });
      },
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const run = consolidate();
    await asked;
    await vi.advanceTimersByTimeAsync(239_000);
    expect(aborted).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    const night = await run;

    expect(aborted).toBeDefined();
    expect(nightBodies).toHaveLength(1);
    expect(night).toMatchObject({ merged: 0, failed: 1, unfinished: true });
    expect(await backgroundChanges()).toEqual([]);
  });

  it("sends a report longer than a Telegram message in parts by lines, each change once (E9)", async () => {
    for (let index = 0; index < 16; index += 1) {
      await extracted(
        `Запись ${String(index).padStart(2, "0")}`,
        "т".repeat(300),
      );
    }
    network();

    const night = await consolidate();

    const sent = telegram.textsIn(OWNER_ID);
    expect(night.reported).toBe(16);
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.every((part) => part.length <= 4096)).toBe(true);
    expect(sent.join("\n")).toBe(
      report(
        ...Array.from(
          { length: 16 },
          (_, index) =>
            `+ Запись ${String(index).padStart(2, "0")} — ${"т".repeat(300)}`,
        ),
      ),
    );
  });

  it("keeps the marks of the part the Bot API took when the next part fails, and the next run sends only the rest (П14)", async () => {
    for (let index = 0; index < 16; index += 1) {
      await extracted(
        `Запись ${String(index).padStart(2, "0")}`,
        "т".repeat(300),
      );
    }
    let sends = 0;
    network({
      botApi: (url, init) => {
        if (url.endsWith("/sendMessage")) sends += 1;
        return url.endsWith("/sendMessage") && sends === 2
          ? Response.json(
              {
                ok: false,
                error_code: 403,
                description: "Forbidden: bot was blocked by the user",
              },
              { status: 403 },
            )
          : telegram.answer(url, init);
      },
    });

    const first = await consolidate();

    const [shown] = telegram.textsIn(OWNER_ID);
    const shownCount =
      shown?.split("\n").filter((line) => line.startsWith("+")).length ?? 0;
    expect(first).toMatchObject({ reported: 0, failed: 1 });
    expect(shownCount).toBeGreaterThan(0);
    expect(shownCount).toBeLessThan(16);
    expect(
      (await backgroundChanges()).map((change) => change.reportedAt !== null),
    ).toEqual(Array.from({ length: 16 }, (_, index) => index < shownCount));

    network();
    const next = await consolidate();
    const third = await consolidate();

    const sent = telegram.textsIn(OWNER_ID);
    expect(next.reported).toBe(16 - shownCount);
    expect(third.reported).toBe(0);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(
      report(
        ...Array.from(
          { length: 16 - shownCount },
          (_, index) =>
            `+ Запись ${String(index + shownCount).padStart(2, "0")} — ${"т".repeat(300)}`,
        ),
      ),
    );
  });

  it("keeps the mark of the kept side of a merge, which has no line, when the merge line went out and a later part fails (П14)", async () => {
    const maria = await remember("Мария", "любит пионы", {
      kind: "person",
      said: new Date(Date.now() - DAY),
    });
    const masha = await remember("Маша", "жена", { kind: "person" });
    unwrap(await mergeEntries([maria, masha], "жена, любит пионы"));
    for (let index = 0; index < 16; index += 1) {
      await extracted(
        `Запись ${String(index).padStart(2, "0")}`,
        "т".repeat(300),
      );
    }
    let sends = 0;
    network({
      botApi: (url, init) => {
        if (url.endsWith("/sendMessage")) sends += 1;
        return url.endsWith("/sendMessage") && sends === 2
          ? Response.json(
              {
                ok: false,
                error_code: 403,
                description: "Forbidden: bot was blocked by the user",
              },
              { status: 403 },
            )
          : telegram.answer(url, init);
      },
    });

    const first = await consolidate();

    const [shown] = telegram.textsIn(OWNER_ID);
    const shownCount =
      shown?.split("\n").filter((line) => line.startsWith("+")).length ?? 0;
    const merges = (await backgroundChanges()).filter(
      (change) => change.action === "merge",
    );
    expect(first).toMatchObject({ reported: 0, failed: 1 });
    expect(shown?.split("\n")[1]).toBe("= «Маша» ← «Мария»");
    expect(merges).toHaveLength(2);
    expect(merges.every((change) => change.reportedAt !== null)).toBe(true);

    network();
    const next = await consolidate();

    expect(next.reported).toBe(16 - shownCount);
    expect(telegram.textsIn(OWNER_ID)[1]).not.toContain("=");
  });

  it("skips the report when the ChatGPT session dies during the pass (E4)", async () => {
    await extracted("Аллергия на орехи", "у владельца");
    const closed = await conversationOf(4, { closed: true });
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (telegram.handles(url)) return telegram.answer(url, init);
        if (url.startsWith("https://auth.openai.com/")) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        return new Response("{}", { status: 401 });
      },
    );

    const night = await consolidate();

    expect(night).toMatchObject({
      conversations: 0,
      reported: 0,
      warnings: ["Сессия ChatGPT кончилась во время прохода: отчёта нет"],
    });
    expect(telegram.textsIn(OWNER_ID)).toEqual([]);
    expect(await cursorOf(closed.id)).toBeNull();
    expect(
      (await backgroundChanges()).map((change) => change.reportedAt),
    ).toEqual([null]);
  });

  it("skips the pass and sends no report without a ChatGPT session (E4)", async () => {
    await extracted("Аллергия на орехи", "у владельца");
    await remember("Мадрид", "командировка", {
      kind: "plan",
      validUntil: new Date(Date.now() - DAY),
    });
    const closed = await conversationOf(4, { closed: true });
    await signOut();
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      requests.push(urlOf(input));
      return new Response("{}", { status: 500 });
    });

    const night = await consolidate();

    expect(requests).toEqual([]);
    expect(night).toMatchObject({
      conversations: 0,
      expired: 0,
      reported: 0,
      warnings: ["Нужен вход в ChatGPT: ночной проход пропущен"],
    });
    expect(await cursorOf(closed.id)).toBeNull();
    expect(
      (await entriesNow()).map(({ title, status }) => ({ title, status })),
    ).toEqual([
      { title: "Аллергия на орехи", status: "active" },
      { title: "Мадрид", status: "active" },
    ]);
    expect(
      (await backgroundChanges()).map((change) => change.reportedAt),
    ).toEqual([null]);
  });

  it("reports only the changes of the background and marks them reported_at; the agent's changes stay unmarked (П14)", async () => {
    await remember("Маша", "жена", { kind: "person" });
    await extracted("Аллергия на орехи", "у владельца");
    network();

    const night = await consolidate();

    expect(night.reported).toBe(1);
    expect(telegram.textsIn(OWNER_ID)).toEqual([
      report("+ Аллергия на орехи — у владельца"),
    ]);
    expect(
      await db
        .select({ actor: changes.actor, reportedAt: changes.reportedAt })
        .from(changes)
        .orderBy(asc(changes.actor)),
    ).toEqual([
      { actor: "agent", reportedAt: null },
      { actor: "extractor", reportedAt: expect.any(Date) },
    ]);
  });
});
