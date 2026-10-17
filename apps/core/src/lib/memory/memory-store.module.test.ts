import { changes, core, entries } from "@repo/db";
import { unwrap } from "@spotsccc/error-as-value";
import { and, asc, eq, type SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Turn } from "../capability";
import { db, pool } from "../db";
import {
  addCoreFact,
  forgetEntry,
  listActive,
  MemoryRefusal,
  removeCoreFact,
  replaceCoreFact,
  restoreEntry,
  saveEntry,
  searchEntries,
  type Refusal,
} from "./memory-store";
import {
  insertMessage,
  ownerTurn,
  resetMemory,
  waitingLocks,
} from "./memory.test-utils";

const HOUR = 3_600_000;

const DAY = 24 * HOUR;

const MASHA = {
  kind: "person",
  title: "Маша",
  text: "жена, день рождения 14 марта, любит пионы",
} as const;

function refusal(value: unknown): Refusal {
  if (!(value instanceof MemoryRefusal)) {
    throw new Error(`Ожидался отказ памяти, а пришло ${String(value)}`);
  }
  return value.refusal;
}

async function activeTitles(): Promise<string[]> {
  const rows = await db
    .select({ title: entries.title })
    .from(entries)
    .where(eq(entries.status, "active"))
    .orderBy(asc(entries.title));
  return rows.map((row) => row.title);
}

async function coreTexts(): Promise<string[]> {
  const memory = unwrap(await listActive());
  return memory.core.map((fact) => fact.text);
}

async function archivedAt(target: SQL): Promise<Date> {
  const [row] = await db
    .select({ at: changes.at })
    .from(changes)
    .where(and(eq(changes.action, "archive"), target));
  if (!row) throw new Error("Нет строки архива в memory.changes");
  return row.at;
}

function fact(index: number, length: number): string {
  return `Факт ${index}: `.padEnd(length, "ж");
}

async function coreOf2990(turn: Turn): Promise<string[]> {
  const texts = Array.from({ length: 10 }, (_, index) =>
    fact(index, index === 9 ? 290 : 300),
  );
  for (const text of texts) {
    unwrap(await addCoreFact({ section: "profile", text }, turn));
  }
  return texts;
}

/**
 * Without idle connections the second transaction waits for its connection, the first one ends
 * meanwhile, and the race never happens.
 */
async function openConnections(): Promise<void> {
  await Promise.all(
    Array.from({ length: 4 }, () => pool.query("select pg_sleep(0.05)")),
  );
}

beforeEach(async () => {
  await resetMemory();
});

describe("saveEntry", () => {
  it("saves «Маша» with the owner's message as its source and a change of the agent (П1)", async () => {
    const turn = await ownerTurn("Запомни: Маша — жена");

    const saved = unwrap(await saveEntry(MASHA, turn));

    expect(saved).toEqual({ id: expect.any(String), version: 1 });
    expect(await db.select().from(entries)).toEqual([
      expect.objectContaining({
        id: saved.id,
        ...MASHA,
        source: "owner",
        sourceMessageId: turn.messageId,
        status: "active",
        version: 1,
      }),
    ]);
    expect(
      await db
        .select({
          entryId: changes.entryId,
          actor: changes.actor,
          action: changes.action,
          conversationId: changes.conversationId,
        })
        .from(changes),
    ).toEqual([
      {
        entryId: saved.id,
        actor: "agent",
        action: "create",
        conversationId: turn.conversationId,
      },
    ]);
  });

  it("refuses the bot's answer as a source with no_source and writes nothing", async () => {
    const turn = await ownerTurn("Запомни: Маша — жена");
    const answer = await insertMessage(
      turn.conversationId,
      "assistant",
      "Запомнил.",
    );

    const saved = await saveEntry(MASHA, {
      conversationId: turn.conversationId,
      messageId: answer,
    });

    expect(refusal(saved)).toEqual({ code: "no_source" });
    expect(await db.select().from(entries)).toEqual([]);
    expect(await db.select().from(changes)).toEqual([]);
  });

  it("refuses «маша» while «Маша» is active with duplicate and her id (П3)", async () => {
    const turn = await ownerTurn("Запомни: Маша — жена");
    const masha = unwrap(await saveEntry(MASHA, turn));

    const saved = await saveEntry({ ...MASHA, title: "маша" }, turn);

    expect(refusal(saved)).toEqual({
      code: "duplicate",
      id: masha.id,
      version: 1,
      text: MASHA.text,
    });
    expect(await activeTitles()).toEqual(["Маша"]);
  });

  it("refuses renaming «Мария» to «МАША» while «Маша» is active with duplicate by the unique index, and changes nothing (П3)", async () => {
    const turn = await ownerTurn("Запомни");
    const masha = unwrap(await saveEntry(MASHA, turn));
    const maria = unwrap(
      await saveEntry({ ...MASHA, title: "Мария", text: "коллега" }, turn),
    );

    const renamed = await saveEntry(
      { ...MASHA, id: maria.id, version: 1, title: "МАША", text: "коллега" },
      turn,
    );

    expect(refusal(renamed)).toEqual({
      code: "duplicate",
      id: masha.id,
      version: 1,
      text: MASHA.text,
    });
    expect(await activeTitles()).toEqual(["Мария", "Маша"]);
    expect(await db.select().from(changes)).toHaveLength(2);
  });

  it("refuses «МАША» by a message older than the archive of «Маша» and accepts it by a newer one (П21)", async () => {
    const first = await ownerTurn("Запомни: Маша — жена");
    const masha = unwrap(await saveEntry(MASHA, first));
    unwrap(await forgetEntry(masha.id, "владелец попросил забыть", first));
    const archived = await archivedAt(eq(changes.entryId, masha.id));
    const morning = await ownerTurn(
      "Запомни: МАША — жена",
      new Date(archived.getTime() - 11 * HOUR),
    );
    const night = await ownerTurn(
      "Запомни: МАША — жена",
      new Date(archived.getTime() + HOUR),
    );

    const stale = await saveEntry({ ...MASHA, title: "МАША" }, morning);

    expect(refusal(stale)).toEqual({
      code: "archived",
      id: masha.id,
      archivedAt: archived,
    });
    expect(await activeTitles()).toEqual([]);
    expect(unwrap(await saveEntry({ ...MASHA, title: "МАША" }, night))).toEqual(
      { id: expect.any(String), version: 1 },
    );
    expect(await activeTitles()).toEqual(["МАША"]);
  });

  it("refuses renaming «Мария» to «МАША» by a message older than the archive of «Маша» and accepts it by a newer one (П21)", async () => {
    const first = await ownerTurn("Запомни: Маша — жена, Мария — коллега");
    const masha = unwrap(await saveEntry(MASHA, first));
    const maria = unwrap(
      await saveEntry({ ...MASHA, title: "Мария", text: "коллега" }, first),
    );
    unwrap(await forgetEntry(masha.id, "владелец попросил забыть", first));
    const archived = await archivedAt(eq(changes.entryId, masha.id));
    const rename = {
      ...MASHA,
      id: maria.id,
      version: 1,
      title: "МАША",
      text: "коллега",
    };
    const morning = await ownerTurn(
      "Мария — это МАША",
      new Date(archived.getTime() - 11 * HOUR),
    );
    const night = await ownerTurn(
      "Мария — это МАША",
      new Date(archived.getTime() + HOUR),
    );

    const stale = await saveEntry(rename, morning);

    expect(refusal(stale)).toEqual({
      code: "archived",
      id: masha.id,
      archivedAt: archived,
    });
    expect(await activeTitles()).toEqual(["Мария"]);
    expect(unwrap(await saveEntry(rename, night))).toEqual({
      id: maria.id,
      version: 2,
    });
    expect(await activeTitles()).toEqual(["МАША"]);
  });

  it("lets an edit of the active «Маша» to «маша» through by a message older than the archive of another «Маша» (П21)", async () => {
    const first = await ownerTurn("Запомни: Маша — жена");
    const old = unwrap(await saveEntry(MASHA, first));
    unwrap(await forgetEntry(old.id, "владелец попросил забыть", first));
    const archived = await archivedAt(eq(changes.entryId, old.id));
    const night = await ownerTurn(
      "Запомни: Маша — жена",
      new Date(archived.getTime() + HOUR),
    );
    const morning = await ownerTurn(
      "Маша любит пионы",
      new Date(archived.getTime() - 11 * HOUR),
    );
    const masha = unwrap(await saveEntry(MASHA, night));

    const edited = await saveEntry(
      { ...MASHA, id: masha.id, version: 1, title: "маша" },
      morning,
    );

    expect(unwrap(edited)).toEqual({ id: masha.id, version: 2 });
    expect(await activeTitles()).toEqual(["маша"]);
  });

  it("makes «МАША» by an older message wait for the archive of «Маша» in progress and refuses it with archived (П21)", async () => {
    const turn = await ownerTurn("Запомни: Маша — жена");
    const masha = unwrap(await saveEntry(MASHA, turn));
    const older = await ownerTurn(
      "Запомни: МАША — жена",
      new Date(Date.now() - HOUR),
    );
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query(
        "select 1 from memory.entries where id = $1 for update",
        [masha.id],
      );
      const forgotten = forgetEntry(masha.id, "владелец попросил забыть", turn);
      await waitingLocks(1);
      const saved = saveEntry({ ...MASHA, title: "МАША" }, older);
      await waitingLocks(2);
      await holder.query("commit");

      expect(unwrap(await forgotten)).toEqual({ id: masha.id });
      expect(refusal(await saved)).toMatchObject({
        code: "archived",
        id: masha.id,
      });
    } finally {
      await holder.query("rollback");
      holder.release();
    }
    expect(await activeTitles()).toEqual([]);
  });

  it("refuses an edit with version 2 after someone else's edit with conflict (П4)", async () => {
    const turn = await ownerTurn("Машина — Škoda");
    const car = { kind: "fact", title: "Машина" } as const;
    const { id } = unwrap(
      await saveEntry({ ...car, text: "Škoda Octavia 2019" }, turn),
    );
    unwrap(
      await saveEntry(
        { ...car, id, version: 1, text: "Škoda Octavia 2020" },
        turn,
      ),
    );
    unwrap(
      await saveEntry(
        { ...car, id, version: 2, text: "Škoda Octavia 2021" },
        turn,
      ),
    );

    const stale = await saveEntry(
      { ...car, id, version: 2, text: "Škoda Octavia 2022" },
      turn,
    );

    expect(refusal(stale)).toEqual({ code: "conflict" });
    expect(
      await db
        .select({ text: entries.text, version: entries.version })
        .from(entries),
    ).toEqual([{ text: "Škoda Octavia 2021", version: 3 }]);
  });

  it("refuses an edit of «Маша» forgotten after the model saw her with conflict and memory_restore in the message, by the version seen before, by the archived one and with a rename to «Мария» forgotten after the source, and changes nothing (П4)", async () => {
    const turn = await ownerTurn("Маша любит тюльпаны");
    const masha = unwrap(await saveEntry(MASHA, turn));
    const maria = unwrap(
      await saveEntry({ ...MASHA, title: "Мария", text: "коллега" }, turn),
    );
    unwrap(await forgetEntry(masha.id, "владелец попросил забыть", turn));
    unwrap(await forgetEntry(maria.id, "владелец попросил забыть", turn));
    const edit = { ...MASHA, id: masha.id, text: "жена, любит тюльпаны" };

    const refused = [
      await saveEntry({ ...edit, version: 1 }, turn),
      await saveEntry({ ...edit, version: 2 }, turn),
      await saveEntry({ ...edit, version: 2, title: "Мария" }, turn),
    ];

    for (const edited of refused) {
      expect(refusal(edited)).toEqual({ code: "conflict" });
      expect(edited instanceof Error && edited.message).toMatch(
        /memory_restore/,
      );
    }
    expect(
      await db
        .select({
          title: entries.title,
          text: entries.text,
          status: entries.status,
          version: entries.version,
        })
        .from(entries)
        .orderBy(asc(entries.title)),
    ).toEqual([
      { title: "Мария", text: "коллега", status: "archived", version: 2 },
      { title: "Маша", text: MASHA.text, status: "archived", version: 2 },
    ]);
    expect(
      await db
        .select({ action: changes.action })
        .from(changes)
        .where(eq(changes.entryId, masha.id))
        .orderBy(asc(changes.at), asc(changes.action)),
    ).toEqual([{ action: "create" }, { action: "archive" }]);
  });

  it("refuses an edit of an id that no entry has with not_found", async () => {
    const turn = await ownerTurn("Маша любит тюльпаны");

    const edited = await saveEntry(
      { ...MASHA, id: crypto.randomUUID(), version: 1 },
      turn,
    );

    expect(refusal(edited)).toEqual({ code: "not_found" });
    expect(await db.select().from(entries)).toEqual([]);
  });

  it("refuses a title of 61 characters and a text of 301 with too_long", async () => {
    const turn = await ownerTurn("Запомни");

    const longTitle = await saveEntry(
      { ...MASHA, title: "М".repeat(61) },
      turn,
    );
    const longText = await saveEntry({ ...MASHA, text: "ж".repeat(301) }, turn);

    expect(refusal(longTitle)).toEqual({ code: "too_long" });
    expect(refusal(longText)).toEqual({ code: "too_long" });
    expect(await db.select().from(entries)).toEqual([]);
  });

  it("refuses a plan without valid_until by the CHECK of memory.entries", async () => {
    const turn = await ownerTurn("Еду в Мадрид");

    const plan = await saveEntry(
      { kind: "plan", title: "Мадрид", text: "командировка" },
      turn,
    );

    expect(refusal(plan)).toEqual({ code: "validation" });
    expect(await db.select().from(entries)).toEqual([]);
  });

  it("saves «Маша» after core_remove of «Маша любит пионы» in the same turn: the archive of the core does not stop the agent (П21)", async () => {
    const turn = await ownerTurn("Маша теперь любит тюльпаны, а не пионы");
    unwrap(
      await addCoreFact({ section: "profile", text: "Маша любит пионы" }, turn),
    );
    unwrap(await removeCoreFact("пионы", "разлюбила", turn));

    const saved = await saveEntry(
      { kind: "person", title: "Маша", text: "любит тюльпаны" },
      turn,
    );

    expect(saved).toEqual({ id: expect.any(String), version: 1 });
    expect(await activeTitles()).toEqual(["Маша"]);
  });

  it("writes an entry of the processing in its transaction with source inferred and a change of the extractor, and a refused one leaves the transaction going (П2, E1)", async () => {
    const turn = await ownerTurn("Кстати, у меня аллергия на орехи");

    const [nuts, again] = await db.transaction(async (tx) => [
      await saveEntry(
        { kind: "fact", title: "Аллергия на орехи", text: "у владельца" },
        turn,
        { tx, source: "inferred" },
      ),
      await saveEntry(
        { kind: "fact", title: "аллергия на орехи", text: "дубль" },
        turn,
        { tx, source: "inferred" },
      ),
    ]);

    const saved = unwrap(nuts ?? new Error("Нет первой записи"));
    expect(refusal(again)).toMatchObject({ code: "duplicate", id: saved.id });
    expect(
      await db
        .select({ title: entries.title, source: entries.source })
        .from(entries),
    ).toEqual([{ title: "Аллергия на орехи", source: "inferred" }]);
    expect(
      await db
        .select({
          actor: changes.actor,
          action: changes.action,
          conversationId: changes.conversationId,
        })
        .from(changes),
    ).toEqual([
      {
        actor: "extractor",
        action: "create",
        conversationId: turn.conversationId,
      },
    ]);
  });

  it("refuses a rename of the processing into a title its own earlier operation took with duplicate by the unique index (П3)", async () => {
    const turn = await ownerTurn("Запомни: Маша — жена, Мария — коллега");

    const renamed = await db.transaction(async (tx) => {
      const masha = unwrap(
        await saveEntry(MASHA, turn, { tx, source: "owner" }),
      );
      const maria = unwrap(
        await saveEntry({ ...MASHA, title: "Мария", text: "коллега" }, turn, {
          tx,
          source: "owner",
        }),
      );
      const result = await saveEntry(
        { ...MASHA, id: maria.id, version: 1, title: "МАША", text: "коллега" },
        turn,
        { tx, source: "owner" },
      );
      return { masha, result };
    });

    expect(refusal(renamed.result)).toEqual({
      code: "duplicate",
      id: renamed.masha.id,
      version: 1,
      text: MASHA.text,
    });
    expect(await activeTitles()).toEqual(["Мария", "Маша"]);
  });
});

describe("searchEntries", () => {
  it("finds «Маша — жена…» for «Что подарить Маше?» by any word of the query, with its version, and counts the use (П8)", async () => {
    const turn = await ownerTurn("Запомни");
    const masha = unwrap(await saveEntry(MASHA, turn));
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

    const found = unwrap(await searchEntries("Что подарить Маше?"));

    expect(found).toEqual([
      expect.objectContaining({ id: masha.id, version: 1, ...MASHA }),
    ]);
    const [row] = await db
      .select({ useCount: entries.useCount, lastUsedAt: entries.lastUsedAt })
      .from(entries)
      .where(eq(entries.id, masha.id));
    expect(row).toEqual({ useCount: 1, lastUsedAt: expect.any(Date) });
  });

  it("does not find an entry whose valid_until was yesterday (П7)", async () => {
    const turn = await ownerTurn("Планы");
    unwrap(
      await saveEntry(
        {
          kind: "plan",
          title: "Мадрид",
          text: "командировка",
          validUntil: new Date(Date.now() - DAY),
        },
        turn,
      ),
    );
    unwrap(
      await saveEntry(
        {
          kind: "plan",
          title: "Лиссабон",
          text: "командировка",
          validUntil: new Date(Date.now() + DAY),
        },
        turn,
      ),
    );

    const found = unwrap(await searchEntries("командировка"));

    expect(found.map((entry) => entry.title)).toEqual(["Лиссабон"]);
  });

  it("does not find a forgotten entry, and finds it with includeArchived (П9)", async () => {
    const turn = await ownerTurn("Запомни");
    const masha = unwrap(await saveEntry(MASHA, turn));
    unwrap(await forgetEntry(masha.id, "владелец попросил забыть", turn));

    expect(unwrap(await searchEntries("Маша"))).toEqual([]);
    expect(
      unwrap(await searchEntries("Маша", { includeArchived: true })),
    ).toEqual([
      expect.objectContaining({ id: masha.id, status: "archived", version: 2 }),
    ]);
  });

  it("answers a query of stop words only with an empty list (E7)", async () => {
    const turn = await ownerTurn("Запомни");
    unwrap(await saveEntry(MASHA, turn));

    expect(unwrap(await searchEntries("и в на"))).toEqual([]);
  });
});

describe("restoreEntry", () => {
  it("brings a forgotten entry back to search with its id, a new version and a restore change (П9)", async () => {
    const turn = await ownerTurn("Верни Машу");
    const masha = unwrap(await saveEntry(MASHA, turn));
    unwrap(await forgetEntry(masha.id, "владелец попросил забыть", turn));

    expect(unwrap(await restoreEntry(masha.id, turn))).toEqual({
      id: masha.id,
    });

    expect(unwrap(await searchEntries("Маша"))).toEqual([
      expect.objectContaining({ id: masha.id, status: "active", version: 3 }),
    ]);
    expect(
      await db
        .select({ action: changes.action, reason: changes.reason })
        .from(changes)
        .where(eq(changes.entryId, masha.id))
        .orderBy(asc(changes.at), asc(changes.action)),
    ).toEqual([
      { action: "create", reason: null },
      { action: "archive", reason: "владелец попросил забыть" },
      { action: "restore", reason: null },
    ]);
  });

  it("refuses to restore an entry whose title another active entry took with duplicate", async () => {
    const turn = await ownerTurn("Запомни");
    const old = unwrap(await saveEntry(MASHA, turn));
    unwrap(await forgetEntry(old.id, "владелец попросил забыть", turn));
    const newer = unwrap(
      await saveEntry(
        { ...MASHA, text: "сестра" },
        await ownerTurn("Запомни: Маша — сестра"),
      ),
    );

    const restored = await restoreEntry(old.id, turn);

    expect(refusal(restored)).toEqual({
      code: "duplicate",
      id: newer.id,
      version: 1,
      text: "сестра",
    });
    expect(
      await db
        .select({ status: entries.status })
        .from(entries)
        .where(eq(entries.id, old.id)),
    ).toEqual([{ status: "archived" }]);
  });
});

describe("addCoreFact", () => {
  it("refuses 20 more characters to a core of 2990 with core_full and the facts of the core (П5)", async () => {
    const turn = await ownerTurn("Запомни");
    const texts = await coreOf2990(turn);

    const added = await addCoreFact(
      { section: "profile", text: "ж".repeat(20) },
      turn,
    );

    expect(refusal(added)).toEqual({
      code: "core_full",
      used: 2990,
      facts: texts,
    });
    expect(await coreTexts()).toEqual(texts);
  });

  it("refuses core_add and core_replace by the bot's answer and by a message that does not exist with no_source, and changes nothing (П1)", async () => {
    const turn = await ownerTurn("Запомни: любит пионы");
    unwrap(
      await addCoreFact({ section: "profile", text: "Любит пионы" }, turn),
    );
    const answer = await insertMessage(
      turn.conversationId,
      "assistant",
      "Запомнил.",
    );
    const refused: unknown[] = [];

    for (const messageId of [answer, crypto.randomUUID()]) {
      const source = { conversationId: turn.conversationId, messageId };
      refused.push(
        await addCoreFact(
          { section: "profile", text: "Любит тюльпаны" },
          source,
        ),
        await replaceCoreFact("пионы", { text: "Любит тюльпаны" }, source),
      );
    }

    expect(refused.map(refusal)).toEqual(
      Array.from({ length: 4 }, () => ({ code: "no_source" })),
    );
    expect(await coreTexts()).toEqual(["Любит пионы"]);
    expect(await db.select().from(changes)).toHaveLength(1);
  });

  it("lets one of two simultaneous additions of 10 characters to a core of 2990 through (E13)", async () => {
    const turn = await ownerTurn("Запомни");
    await coreOf2990(turn);
    await openConnections();

    const added = await Promise.all([
      addCoreFact({ section: "profile", text: "А".repeat(10) }, turn),
      addCoreFact({ section: "profile", text: "Б".repeat(10) }, turn),
    ]);

    const refused = added.filter((result) => result instanceof Error);
    expect(added.filter((result) => !(result instanceof Error))).toEqual([
      { used: 3000 },
    ]);
    expect(refused.map(refusal)).toEqual([
      expect.objectContaining({ code: "core_full", used: 3000 }),
    ]);
    expect(await coreTexts()).toHaveLength(11);
  });

  it("refuses the text of a fact removed later than the source message, in another case, with archived (П21)", async () => {
    const turn = await ownerTurn("Запомни: любит пионы");
    unwrap(
      await addCoreFact({ section: "profile", text: "Любит пионы" }, turn),
    );
    const [removed] = await db.select({ id: core.id }).from(core);
    if (!removed) throw new Error("Факт ядра не записан");
    unwrap(await removeCoreFact("пионы", "разлюбила", turn));
    const archived = await archivedAt(eq(changes.coreId, removed.id));
    const older = await ownerTurn(
      "Запомни: любит пионы",
      new Date(archived.getTime() - HOUR),
    );

    const added = await addCoreFact(
      { section: "profile", text: "ЛЮБИТ ПИОНЫ" },
      older,
    );

    expect(refusal(added)).toEqual({
      code: "archived",
      id: removed.id,
      archivedAt: archived,
    });
    expect(await coreTexts()).toEqual([]);
  });
});

describe("replaceCoreFact and removeCoreFact", () => {
  const BUENOS_AIRES = "Иван, живёт в Буэнос-Айресе";
  const BELGRADE =
    "Иван, живёт в Белграде с октября 2026, раньше — Буэнос-Айрес";

  async function factRows() {
    return db
      .select({ text: core.text, version: core.version, status: core.status })
      .from(core)
      .orderBy(asc(core.id));
  }

  it("replaces the fact quoted by «Буэнос-Айрес» as a whole, raises its version and keeps before and after (П20)", async () => {
    const turn = await ownerTurn("Я переехал в Белград");
    unwrap(await addCoreFact({ section: "profile", text: BUENOS_AIRES }, turn));
    unwrap(
      await addCoreFact(
        { section: "profile", text: "Жена Маша: любит пионы" },
        turn,
      ),
    );

    const replaced = unwrap(
      await replaceCoreFact("Буэнос-Айрес", { text: BELGRADE }, turn),
    );

    expect(replaced).toEqual({
      used: BELGRADE.length + "Жена Маша: любит пионы".length,
    });
    expect(await factRows()).toEqual([
      { text: BELGRADE, version: 2, status: "active" },
      { text: "Жена Маша: любит пионы", version: 1, status: "active" },
    ]);
    expect(
      await db
        .select({ before: changes.before, after: changes.after })
        .from(changes)
        .where(eq(changes.action, "update")),
    ).toEqual([
      {
        before: expect.objectContaining({ text: BUENOS_AIRES, version: 1 }),
        after: expect.objectContaining({ text: BELGRADE, version: 2 }),
      },
    ]);
  });

  it("lets a replacement fill the core to exactly 3000 characters and refuses one more character with core_full (П5)", async () => {
    const turn = await ownerTurn("Запомни");
    for (let index = 0; index < 9; index += 1) {
      unwrap(
        await addCoreFact({ section: "profile", text: fact(index, 300) }, turn),
      );
    }
    unwrap(await addCoreFact({ section: "profile", text: fact(9, 280) }, turn));
    unwrap(
      await addCoreFact({ section: "profile", text: "Б".repeat(10) }, turn),
    );

    const filled = await replaceCoreFact(
      "ББББ",
      { text: "В".repeat(20) },
      turn,
    );
    const overfilled = await replaceCoreFact(
      "ВВВВ",
      { text: "Г".repeat(21) },
      turn,
    );

    expect(unwrap(filled)).toEqual({ used: 3000 });
    expect(refusal(overfilled)).toMatchObject({
      code: "core_full",
      used: 3000,
    });
    expect(await factRows()).toContainEqual({
      text: "В".repeat(20),
      version: 2,
      status: "active",
    });
    expect(
      await db.select().from(changes).where(eq(changes.action, "update")),
    ).toHaveLength(1);
  });

  it("finds the same fact by «буэнос-айрес» in lower case", async () => {
    const turn = await ownerTurn("Я переехал в Белград");
    unwrap(await addCoreFact({ section: "profile", text: BUENOS_AIRES }, turn));

    unwrap(await replaceCoreFact("буэнос-айрес", { text: BELGRADE }, turn));

    expect(await coreTexts()).toEqual([BELGRADE]);
  });

  it("refuses «Белград» found in two facts with ambiguous and both of them, and changes nothing", async () => {
    const turn = await ownerTurn("Белград");
    const facts = ["Иван, живёт в Белграде", "Офис в Белграде, у вокзала"];
    for (const text of facts) {
      unwrap(await addCoreFact({ section: "profile", text }, turn));
    }

    const replaced = await replaceCoreFact(
      "Белград",
      { text: "Нови-Сад" },
      turn,
    );

    expect(refusal(replaced)).toEqual({ code: "ambiguous", facts });
    expect(await coreTexts()).toEqual(facts);
  });

  it("refuses a quote with «<\\/» as ambiguous when one fact has «</» and another a literal «<\\/», which look the same in the context, and changes neither (П15)", async () => {
    const turn = await ownerTurn("Запомни");
    const facts = [
      "Показывай </div> в примерах",
      "Показывай <\\/div> в примерах",
    ];
    for (const text of facts) {
      unwrap(await addCoreFact({ section: "instructions", text }, turn));
    }

    const removed = await removeCoreFact(
      "Показывай <\\/div>",
      "не нужно",
      turn,
    );
    const replaced = await replaceCoreFact(
      "<fact>Показывай <\\/div> в примерах</fact>",
      { text: "Показывай теги в примерах" },
      turn,
    );

    expect(refusal(removed)).toEqual({ code: "ambiguous", facts });
    expect(refusal(replaced)).toEqual({ code: "ambiguous", facts });
    expect(await coreTexts()).toEqual(facts);
  });

  it("refuses a quote across the boundary of two facts with not_found and the facts of the core", async () => {
    const turn = await ownerTurn("Белград");
    const facts = ["Иван, живёт в Белграде", "Жена Маша"];
    for (const text of facts) {
      unwrap(await addCoreFact({ section: "profile", text }, turn));
    }

    const removed = await removeCoreFact("Белграде Жена", "переехал", turn);

    expect(refusal(removed)).toEqual({ code: "not_found", facts });
    expect(await coreTexts()).toEqual(facts);
  });

  it("drops the <fact date=…> prefix the model copied and finds the fact", async () => {
    const turn = await ownerTurn("Я переехал в Белград");
    unwrap(await addCoreFact({ section: "profile", text: BUENOS_AIRES }, turn));

    unwrap(
      await replaceCoreFact(
        `<fact date="2026-03-02">${BUENOS_AIRES}`,
        { text: BELGRADE },
        turn,
      ),
    );

    expect(await coreTexts()).toEqual([BELGRADE]);
  });

  it("finds the whole fact by a quote from the second line of a fact in several lines", async () => {
    const turn = await ownerTurn("Формат отчёта");
    const report = "Формат утреннего отчёта:\n- погода\n- встречи дня";
    unwrap(await addCoreFact({ section: "instructions", text: report }, turn));

    unwrap(
      await replaceCoreFact(
        "- погода",
        { text: "Формат утреннего отчёта:\n- встречи дня" },
        turn,
      ),
    );

    expect(await coreTexts()).toEqual([
      "Формат утреннего отчёта:\n- встречи дня",
    ]);
  });

  it("removes the fact quoted by «пионы» from the core and answers with its text (П9)", async () => {
    const turn = await ownerTurn("Забудь про пионы");
    unwrap(
      await addCoreFact(
        { section: "profile", text: "Жена Маша: любит пионы" },
        turn,
      ),
    );
    unwrap(await addCoreFact({ section: "profile", text: BUENOS_AIRES }, turn));

    const removed = unwrap(await removeCoreFact("пионы", "разлюбила", turn));

    expect(removed).toEqual({ removed: "Жена Маша: любит пионы" });
    expect(await coreTexts()).toEqual([BUENOS_AIRES]);
    expect(await factRows()).toContainEqual({
      text: "Жена Маша: любит пионы",
      version: 2,
      status: "archived",
    });
  });

  it("refuses to replace a fact with the text of a fact removed later than the source message with archived, and accepts it by a newer message (П21)", async () => {
    const turn = await ownerTurn("Запомни: любит пионы и тюльпаны");
    unwrap(
      await addCoreFact({ section: "profile", text: "Любит пионы" }, turn),
    );
    const [removed] = await db.select({ id: core.id }).from(core);
    if (!removed) throw new Error("Факт ядра не записан");
    unwrap(await removeCoreFact("пионы", "разлюбила", turn));
    unwrap(
      await addCoreFact({ section: "profile", text: "Любит тюльпаны" }, turn),
    );
    const archived = await archivedAt(eq(changes.coreId, removed.id));
    const older = await ownerTurn(
      "Не тюльпаны, а пионы",
      new Date(archived.getTime() - HOUR),
    );
    const changesBefore = await db.select().from(changes);

    const replaced = await replaceCoreFact(
      "тюльпаны",
      { text: "ЛЮБИТ ПИОНЫ" },
      older,
    );

    expect(refusal(replaced)).toEqual({
      code: "archived",
      id: removed.id,
      archivedAt: archived,
    });
    expect(await coreTexts()).toEqual(["Любит тюльпаны"]);
    expect(await db.select().from(changes)).toEqual(changesBefore);

    const newer = await ownerTurn("Снова любит пионы");
    unwrap(await replaceCoreFact("тюльпаны", { text: "ЛЮБИТ ПИОНЫ" }, newer));
    expect(await coreTexts()).toEqual(["ЛЮБИТ ПИОНЫ"]);
  });
});

describe("listActive", () => {
  it("returns only active facts and entries whose valid_until has not passed (П7, П9)", async () => {
    const turn = await ownerTurn("Запомни");
    const yesterday = new Date(Date.now() - DAY);
    const tomorrow = new Date(Date.now() + DAY);
    unwrap(
      await addCoreFact(
        { section: "profile", text: "Иван, живёт в Белграде" },
        turn,
      ),
    );
    unwrap(
      await addCoreFact(
        { section: "profile", text: "Ищет работу", validUntil: yesterday },
        turn,
      ),
    );
    unwrap(
      await addCoreFact(
        { section: "instructions", text: "Отвечай коротко" },
        turn,
      ),
    );
    unwrap(await removeCoreFact("коротко", "владелец передумал", turn));
    unwrap(await saveEntry(MASHA, turn));
    unwrap(
      await saveEntry(
        {
          kind: "plan",
          title: "Мадрид",
          text: "командировка",
          validUntil: yesterday,
        },
        turn,
      ),
    );
    unwrap(
      await saveEntry(
        {
          kind: "plan",
          title: "Лиссабон",
          text: "отпуск",
          validUntil: tomorrow,
        },
        turn,
      ),
    );
    const car = unwrap(
      await saveEntry(
        { kind: "fact", title: "Машина", text: "Škoda Octavia" },
        turn,
      ),
    );
    unwrap(await forgetEntry(car.id, "продал", turn));

    const memory = unwrap(await listActive());

    expect(memory.core.map((fact) => fact.text)).toEqual([
      "Иван, живёт в Белграде",
    ]);
    expect(memory.entries.map((entry) => entry.title)).toEqual([
      "Лиссабон",
      "Маша",
    ]);
  });
});
