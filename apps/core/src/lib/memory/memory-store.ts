import {
  changes,
  core,
  entries,
  messages,
  type CoreSection,
  type EntryKind,
} from "@repo/db";
import { createTaggedError } from "@spotsccc/error-as-value";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Turn } from "../capability";
import { db, type Tx } from "../db";

const TITLE_MAX = 60;

const TEXT_MAX = 300;

export const CORE_MAX = 3000;

const SEARCH_LIMIT = 8;

export type Refusal =
  | { code: "no_source" | "conflict" | "too_long" | "validation" }
  | { code: "duplicate"; id: string; version: number; text: string }
  | { code: "archived"; id: string | number; archivedAt: Date }
  | { code: "not_found"; facts?: string[] }
  | { code: "core_full"; used: number; facts: string[] }
  | { code: "ambiguous"; facts: string[] };

/** The tool hands `refusal` to the model as a value, so the model can fix its call. */
export class MemoryRefusal extends createTaggedError({
  name: "MemoryRefusal",
}) {
  readonly refusal: Refusal;

  constructor(refusal: Refusal, message: string) {
    super({ message });
    this.refusal = refusal;
  }
}

export type Entry = {
  id: string;
  version: number;
  kind: EntryKind;
  title: string;
  text: string;
  validUntil: Date | null;
  status: "active" | "archived";
  updatedAt: Date;
};

export type CoreFact = {
  id: number;
  version: number;
  section: CoreSection;
  text: string;
  updatedAt: Date;
};

export type NightEntry = {
  id: string;
  version: number;
  kind: EntryKind;
  title: string;
  text: string;
  source: "owner" | "inferred";
  said: Date;
  useCount: number;
};

export type ReportedChange = {
  id: string;
  at: Date;
  action: typeof changes.$inferSelect.action;
  entryId: string | null;
  title: string | null;
  text: string | null;
  status: string | null;
  keptTitle: string | null;
};

/** Without `search`: Postgres computes it, and the journal does not need it. */
const entryColumns = {
  id: entries.id,
  kind: entries.kind,
  title: entries.title,
  text: entries.text,
  source: entries.source,
  sourceMessageId: entries.sourceMessageId,
  validUntil: entries.validUntil,
  status: entries.status,
  supersededBy: entries.supersededBy,
  version: entries.version,
  useCount: entries.useCount,
  lastUsedAt: entries.lastUsedAt,
  createdAt: entries.createdAt,
  updatedAt: entries.updatedAt,
};

const entryFields = {
  id: entries.id,
  version: entries.version,
  kind: entries.kind,
  title: entries.title,
  text: entries.text,
  validUntil: entries.validUntil,
  status: entries.status,
  updatedAt: entries.updatedAt,
};

/**
 * An edit checks П21 only when it changes the title beyond case: otherwise nothing forgotten comes
 * back. With `extraction` each operation runs in a savepoint of the processing's transaction, so a
 * refusal keeps the others and any other failure rolls back the whole part (E1).
 */
export async function saveEntry(
  input: {
    id?: string;
    version?: number;
    kind: EntryKind;
    title: string;
    text: string;
    validUntil?: Date;
  },
  turn: Turn,
  extraction?: { tx: Tx; source: "owner" | "inferred" },
): Promise<Error | { id: string; version: number }> {
  const title = input.title.trim();
  const text = input.text.trim();
  if (charLength(title) > TITLE_MAX || charLength(text) > TEXT_MAX) {
    return new MemoryRefusal(
      { code: "too_long" },
      `Название — не длиннее ${TITLE_MAX} символов, текст — не длиннее ${TEXT_MAX}`,
    );
  }
  if (!title || !text) {
    return new MemoryRefusal(
      { code: "validation" },
      "Пустое название или текст",
    );
  }
  const { id, version } = input;
  if ((id === undefined) !== (version === undefined)) {
    return new MemoryRefusal(
      { code: "validation" },
      "Правке нужны id и version записи, которую ты видел",
    );
  }
  const actor = extraction ? "extractor" : "agent";
  const values = {
    kind: input.kind,
    title,
    text,
    validUntil: input.validUntil ?? null,
    source: extraction?.source ?? "owner",
    sourceMessageId: turn.messageId,
  };

  const write = async (tx: Tx) => {
    await lock(tx, "memory.entries");
    const message = await sourceMessage(tx, turn.messageId);
    if (message instanceof Error) throw message;

    if (id === undefined || version === undefined) {
      const forgotten =
        (await forgottenTitle(tx, title, message)) ??
        (extraction &&
          (await forgottenForProcessing(tx, title, {
            id: turn.messageId,
            createdAt: message.createdAt,
          })));
      if (forgotten) throw forgotten;
      const existing = await activeEntry(tx, title);
      if (existing) throw duplicate(existing);

      const [created] = await tx
        .insert(entries)
        .values(values)
        .returning(entryColumns);
      if (!created) throw new Error("INSERT записи не вернул строку");
      await tx.insert(changes).values({
        entryId: created.id,
        actor,
        action: "create",
        after: created,
        conversationId: turn.conversationId,
      });
      return { id: created.id, version: created.version };
    }

    const [found] = await tx
      .select({
        before: entryColumns,
        renamed: sql<boolean>`not (${sameText(entries.title, title)})`,
      })
      .from(entries)
      .where(eq(entries.id, id));
    if (!found) {
      throw new MemoryRefusal({ code: "not_found" }, `Записи ${id} нет`);
    }
    const { before, renamed } = found;
    if (before.status === "archived") {
      throw new MemoryRefusal(
        { code: "conflict" },
        "Запись уже забыта: вернуть её можно только memory_restore",
      );
    }
    if (renamed) {
      const forgotten = await forgottenTitle(tx, title, message);
      if (forgotten) throw forgotten;
    }
    const [after] = await tx
      .update(entries)
      .set({
        ...values,
        version: sql`${entries.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(entries.id, id),
          eq(entries.version, version),
          eq(entries.status, "active"),
        ),
      )
      .returning(entryColumns);
    if (!after) {
      throw new MemoryRefusal(
        { code: "conflict" },
        "Запись уже изменилась: найди её заново через memory_search",
      );
    }
    await tx.insert(changes).values({
      entryId: id,
      actor,
      action: "update",
      before,
      after,
      conversationId: turn.conversationId,
    });
    return { id, version: after.version };
  };
  const saved = extraction
    ? extraction.tx.transaction(write)
    : db.transaction(write);
  return saved.catch((cause: unknown) =>
    refusedOr(cause, "Не удалось сохранить запись", title, extraction?.tx),
  );
}

export async function forgetEntry(
  id: string,
  reason: string,
  turn: Turn,
): Promise<Error | { id: string }> {
  return db
    .transaction(async (tx) => {
      await lock(tx, "memory.entries");
      const [before] = await tx
        .select(entryColumns)
        .from(entries)
        .where(and(eq(entries.id, id), eq(entries.status, "active")))
        .for("update");
      if (!before) throw entryNotFound(id, "активных");
      const [after] = await tx
        .update(entries)
        .set({
          status: "archived",
          version: sql`${entries.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(entries.id, id))
        .returning(entryColumns);
      await tx.insert(changes).values({
        entryId: id,
        actor: "agent",
        action: "archive",
        before,
        after,
        conversationId: turn.conversationId,
        reason,
      });
      return { id };
    })
    .catch((cause: unknown) =>
      refusedOr(cause, "Не удалось убрать запись в архив"),
    );
}

/** An entry the night archived for its term would come back expired, unseen and archived again (П9). */
export async function restoreEntry(
  { id, validUntil }: { id: string; validUntil?: Date },
  turn: Turn,
): Promise<Error | { id: string }> {
  let title: string | undefined;
  return db
    .transaction(async (tx) => {
      await lock(tx, "memory.entries");
      const [before] = await tx
        .select(entryColumns)
        .from(entries)
        .where(and(eq(entries.id, id), eq(entries.status, "archived")))
        .for("update");
      if (!before) throw entryNotFound(id, "забытых");
      title = before.title;
      const term = validUntil ?? before.validUntil;
      if (term && term.getTime() <= Date.now()) {
        throw new MemoryRefusal(
          { code: "validation" },
          "Срок записи прошёл: передай validUntil — новый последний день, когда она верна",
        );
      }
      const existing = await activeEntry(tx, before.title);
      if (existing) throw duplicate(existing);

      const [after] = await tx
        .update(entries)
        .set({
          status: "active",
          validUntil: term,
          version: sql`${entries.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(entries.id, id))
        .returning(entryColumns);
      await tx.insert(changes).values({
        entryId: id,
        actor: "agent",
        action: "restore",
        before,
        after,
        conversationId: turn.conversationId,
      });
      return { id };
    })
    .catch((cause: unknown) =>
      refusedOr(cause, "Не удалось вернуть запись из архива", title),
    );
}

/**
 * The lexemes of the query joined with OR (П8, П13): with AND a natural question finds nothing
 * (spike results, item 3). A query of stop words alone gives NULL, which matches nothing.
 */
export function anyWordQuery(query: string): SQL {
  return sql`(
    select string_agg('''' || replace(replace(word, '\\', '\\\\'), '''', '''''') || '''', ' | ')::tsquery
      from unnest(tsvector_to_array(to_tsvector('russian', lower(${query}::text COLLATE "und-x-icu")))) as word
  )`;
}

/**
 * A use is not a change of the entry, so `version` and `updated_at` stay. The count skips rows
 * another transaction holds: a merge or a processing updates several entries one by one, and a
 * search waiting for one of them would deadlock with it (E18).
 */
export async function searchEntries(
  query: string,
  { includeArchived = false }: { includeArchived?: boolean } = {},
): Promise<Error | Entry[]> {
  const words = anyWordQuery(query);
  const found = await db
    .select(entryFields)
    .from(entries)
    .where(
      and(
        sql`${entries.search} @@ ${words}`,
        includeArchived
          ? or(eq(entries.status, "archived"), unexpired(entries.validUntil))
          : and(eq(entries.status, "active"), unexpired(entries.validUntil)),
      ),
    )
    .orderBy(
      sql`ts_rank(${entries.search}, ${words}) desc`,
      desc(entries.updatedAt),
    )
    .limit(SEARCH_LIMIT)
    .catch((cause: unknown) => new Error("Не удалось найти записи", { cause }));
  if (found instanceof Error || found.length === 0) return found;

  const free = db
    .select({ id: entries.id })
    .from(entries)
    .where(
      inArray(
        entries.id,
        found.map((entry) => entry.id),
      ),
    )
    .for("update", { skipLocked: true });
  const counted = await db
    .update(entries)
    .set({ useCount: sql`${entries.useCount} + 1`, lastUsedAt: sql`now()` })
    .where(inArray(entries.id, free))
    .catch(
      (cause: unknown) =>
        new Error("Не удалось отметить найденные записи", { cause }),
    );
  if (counted instanceof Error) return counted;
  return found;
}

export async function addCoreFact(
  input: { section: CoreSection; text: string; validUntil?: Date },
  turn: Turn,
): Promise<Error | { used: number }> {
  const text = input.text.trim();
  const refused = checkFact(text);
  if (refused) return refused;

  return db
    .transaction(async (tx) => {
      await lock(tx, "memory.core");
      const message = await sourceMessage(tx, turn.messageId);
      if (message instanceof Error) throw message;
      const forgotten = await forgottenFact(tx, text, message);
      if (forgotten) throw forgotten;
      const facts = await coreFacts(tx);
      const used = usedBy(facts) + charLength(text);
      if (used > CORE_MAX) throw coreFull(facts);

      const [created] = await tx
        .insert(core)
        .values({
          section: input.section,
          text,
          validUntil: input.validUntil ?? null,
          source: "owner",
          sourceMessageId: turn.messageId,
        })
        .returning();
      if (!created) throw new Error("INSERT факта ядра не вернул строку");
      await tx.insert(changes).values({
        coreId: created.id,
        actor: "agent",
        action: "create",
        after: created,
        conversationId: turn.conversationId,
      });
      return { used };
    })
    .catch((cause: unknown) =>
      refusedOr(cause, "Не удалось добавить факт в ядро"),
    );
}

export async function replaceCoreFact(
  old: string,
  input: { text: string; validUntil?: Date },
  turn: Turn,
): Promise<Error | { used: number }> {
  const text = input.text.trim();
  const refused = checkFact(text);
  if (refused) return refused;

  return db
    .transaction(async (tx) => {
      await lock(tx, "memory.core");
      const source = await sourceMessage(tx, turn.messageId);
      if (source instanceof Error) throw source;
      const facts = await coreFacts(tx, old);
      const before = quotedFact(facts);
      if (before instanceof Error) throw before;
      const forgotten = await forgottenFact(tx, text, source);
      if (forgotten) throw forgotten;
      const used =
        usedBy(facts) - charLength(before.row.text) + charLength(text);
      if (used > CORE_MAX) throw coreFull(facts);

      const [after] = await tx
        .update(core)
        .set({
          text,
          validUntil: input.validUntil ?? null,
          source: "owner",
          sourceMessageId: turn.messageId,
          version: sql`${core.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(
          and(eq(core.id, before.row.id), eq(core.version, before.row.version)),
        )
        .returning();
      if (!after) {
        throw new MemoryRefusal(
          { code: "conflict" },
          "Факт ядра уже изменился, попробуй ещё раз",
        );
      }
      await tx.insert(changes).values({
        coreId: after.id,
        actor: "agent",
        action: "update",
        before: before.row,
        after,
        conversationId: turn.conversationId,
      });
      return { used };
    })
    .catch((cause: unknown) =>
      refusedOr(cause, "Не удалось заменить факт ядра"),
    );
}

export async function removeCoreFact(
  old: string,
  reason: string,
  turn: Turn,
): Promise<Error | { removed: string }> {
  return db
    .transaction(async (tx) => {
      await lock(tx, "memory.core");
      const before = quotedFact(await coreFacts(tx, old));
      if (before instanceof Error) throw before;
      const [after] = await tx
        .update(core)
        .set({
          status: "archived",
          version: sql`${core.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(core.id, before.row.id))
        .returning();
      await tx.insert(changes).values({
        coreId: before.row.id,
        actor: "agent",
        action: "archive",
        before: before.row,
        after,
        conversationId: turn.conversationId,
        reason,
      });
      return { removed: before.row.text };
    })
    .catch((cause: unknown) => refusedOr(cause, "Не удалось убрать факт ядра"));
}

export async function listCore(): Promise<
  Error | { facts: CoreFact[]; used: number }
> {
  const facts = await db
    .select({
      id: core.id,
      version: core.version,
      section: core.section,
      text: core.text,
      updatedAt: core.updatedAt,
    })
    .from(core)
    .where(and(eq(core.status, "active"), unexpired(core.validUntil)))
    .orderBy(asc(core.id))
    .catch(
      (cause: unknown) => new Error("Не удалось прочитать ядро", { cause }),
    );
  if (facts instanceof Error) return facts;
  return {
    facts,
    used: facts.reduce((sum, fact) => sum + charLength(fact.text), 0),
  };
}

export async function listActive(): Promise<
  Error | { core: CoreFact[]; entries: Entry[] }
> {
  const [memoryCore, active] = await Promise.all([
    listCore(),
    db
      .select(entryFields)
      .from(entries)
      .where(and(eq(entries.status, "active"), unexpired(entries.validUntil)))
      .orderBy(sql`${entries.title} COLLATE "und-x-icu"`)
      .catch(
        (cause: unknown) => new Error("Не удалось прочитать записи", { cause }),
      ),
  ]);
  if (memoryCore instanceof Error) return memoryCore;
  if (active instanceof Error) return active;
  return { core: memoryCore.facts, entries: active };
}

/** `said` is when the owner said what an entry holds: of duplicates, the later word stays (П12). */
export async function nightMemory(): Promise<
  Error | { core: CoreFact[]; used: number; entries: NightEntry[] }
> {
  const [memoryCore, active] = await Promise.all([
    listCore(),
    db
      .select({
        id: entries.id,
        version: entries.version,
        kind: entries.kind,
        title: entries.title,
        text: entries.text,
        source: entries.source,
        said: messages.createdAt,
        useCount: entries.useCount,
      })
      .from(entries)
      .innerJoin(messages, eq(messages.id, entries.sourceMessageId))
      .where(and(eq(entries.status, "active"), unexpired(entries.validUntil)))
      .orderBy(asc(entries.kind), asc(messages.createdAt))
      .catch(
        (cause: unknown) => new Error("Не удалось прочитать записи", { cause }),
      ),
  ]);
  if (memoryCore instanceof Error) return memoryCore;
  if (active instanceof Error) return active;
  return { core: memoryCore.facts, used: memoryCore.used, entries: active };
}

export async function archiveExpired(): Promise<Error | number> {
  return db
    .transaction(async (tx) => {
      await lock(tx, "memory.core");
      await lock(tx, "memory.entries");
      const entriesBefore = await tx
        .select(entryColumns)
        .from(entries)
        .where(and(eq(entries.status, "active"), expired(entries.validUntil)));
      const factsBefore = await tx
        .select()
        .from(core)
        .where(and(eq(core.status, "active"), expired(core.validUntil)));
      const archive = {
        status: "archived" as const,
        updatedAt: sql`now()`,
      };
      const entriesAfter =
        entriesBefore.length === 0
          ? []
          : await tx
              .update(entries)
              .set({ ...archive, version: sql`${entries.version} + 1` })
              .where(
                inArray(
                  entries.id,
                  entriesBefore.map((entry) => entry.id),
                ),
              )
              .returning(entryColumns);
      const factsAfter =
        factsBefore.length === 0
          ? []
          : await tx
              .update(core)
              .set({ ...archive, version: sql`${core.version} + 1` })
              .where(
                inArray(
                  core.id,
                  factsBefore.map((fact) => fact.id),
                ),
              )
              .returning();
      const rows = [
        ...entriesAfter.map((after) => ({
          entryId: after.id,
          before: entriesBefore.find((entry) => entry.id === after.id),
          after,
        })),
        ...factsAfter.map((after) => ({
          coreId: after.id,
          before: factsBefore.find((fact) => fact.id === after.id),
          after,
        })),
      ].map((row) => ({
        ...row,
        actor: "consolidator" as const,
        action: "archive" as const,
        reason: "срок прошёл",
      }));
      if (rows.length > 0) await tx.insert(changes).values(rows);
      return rows.length;
    })
    .catch(
      (cause: unknown) =>
        new Error("Не удалось убрать в архив память с прошедшим сроком", {
          cause,
        }),
    );
}

/**
 * The time of the source message, not of the write, picks the entry that stays: the processing of
 * an old conversation writes the owner's earlier word late (П12).
 */
export async function mergeEntries(
  seen: { id: string; version: number }[],
  text: string,
): Promise<Error | { id: string; version: number }> {
  const merged = text.trim();
  if (charLength(merged) > TEXT_MAX) {
    return new MemoryRefusal(
      { code: "too_long" },
      `Текст записи — не длиннее ${TEXT_MAX} символов`,
    );
  }
  if (!merged) {
    return new MemoryRefusal({ code: "validation" }, "Пустой текст записи");
  }
  if (seen.length < 2) {
    return new MemoryRefusal(
      { code: "validation" },
      "Слить можно две записи или больше: запись уходит в архив только со ссылкой на заменившую",
    );
  }

  return db
    .transaction(async (tx) => {
      await lock(tx, "memory.entries");
      const found = await tx
        .select({ row: entryColumns, said: messages.createdAt })
        .from(entries)
        .innerJoin(messages, eq(messages.id, entries.sourceMessageId))
        .where(
          and(
            inArray(
              entries.id,
              seen.map((entry) => entry.id),
            ),
            eq(entries.status, "active"),
          ),
        );
      const unchanged = seen.every((entry) =>
        found.some(
          ({ row }) => row.id === entry.id && row.version === entry.version,
        ),
      );
      const [kept, ...rest] = found.sort(
        (a, b) =>
          b.said.getTime() - a.said.getTime() ||
          b.row.updatedAt.getTime() - a.row.updatedAt.getTime(),
      );
      if (!unchanged || !kept) throw changedSince();

      const [keptAfter] = await tx
        .update(entries)
        .set({
          text: merged,
          version: sql`${entries.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(entries.id, kept.row.id))
        .returning(entryColumns);
      const restAfter = await tx
        .update(entries)
        .set({
          status: "archived",
          supersededBy: kept.row.id,
          version: sql`${entries.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(
          inArray(
            entries.id,
            rest.map(({ row }) => row.id),
          ),
        )
        .returning(entryColumns);
      await tx.insert(changes).values([
        {
          entryId: kept.row.id,
          actor: "consolidator",
          action: "merge",
          before: kept.row,
          after: keptAfter,
        },
        ...restAfter.map((after) => ({
          entryId: after.id,
          actor: "consolidator" as const,
          action: "merge" as const,
          before: rest.find(({ row }) => row.id === after.id)?.row,
          after,
          reason: `дубль записи «${kept.row.title}»`,
        })),
      ]);
      if (!keptAfter) throw new Error("UPDATE записи не вернул строку");
      return { id: keptAfter.id, version: keptAfter.version };
    })
    .catch((cause: unknown) => refusedOr(cause, "Не удалось слить записи"));
}

export async function moveToCore(seen: {
  id: string;
  version: number;
}): Promise<Error | { used: number }> {
  return db
    .transaction(async (tx) => {
      await lock(tx, "memory.core");
      await lock(tx, "memory.entries");
      const [before] = await tx
        .select(entryColumns)
        .from(entries)
        .where(and(eq(entries.id, seen.id), eq(entries.status, "active")));
      if (before?.version !== seen.version) throw changedSince();
      const text = `${before.title} — ${before.text}`;
      if (charLength(text) > TEXT_MAX) {
        throw new MemoryRefusal(
          { code: "too_long" },
          `Факт ядра — не длиннее ${TEXT_MAX} символов`,
        );
      }
      const facts = await coreFacts(tx);
      const used = usedBy(facts) + charLength(text);
      if (used > CORE_MAX) throw coreFull(facts);

      const [after] = await tx
        .update(entries)
        .set({
          status: "archived",
          version: sql`${entries.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(entries.id, before.id))
        .returning(entryColumns);
      const [created] = await tx
        .insert(core)
        .values({
          section: "profile",
          text,
          source: before.source,
          sourceMessageId: before.sourceMessageId,
          validUntil: before.validUntil,
        })
        .returning();
      if (!created) throw new Error("INSERT факта ядра не вернул строку");
      await tx.insert(changes).values([
        {
          entryId: before.id,
          actor: "consolidator",
          action: "move",
          before,
          after,
        },
        {
          coreId: created.id,
          actor: "consolidator",
          action: "move",
          after: created,
        },
      ]);
      return { used };
    })
    .catch((cause: unknown) =>
      refusedOr(cause, "Не удалось перенести запись в ядро"),
    );
}

/** П17, П2: «Указания» stay in the core: only the agent in a turn writes them. */
export async function moveToEntries(
  seen: { id: number; version: number },
  input: { kind: EntryKind; title: string },
): Promise<Error | { id: string }> {
  const title = input.title.trim();
  if (charLength(title) > TITLE_MAX) {
    return new MemoryRefusal(
      { code: "too_long" },
      `Название — не длиннее ${TITLE_MAX} символов`,
    );
  }
  if (!title) {
    return new MemoryRefusal({ code: "validation" }, "Пустое название");
  }

  return db
    .transaction(async (tx) => {
      await lock(tx, "memory.core");
      await lock(tx, "memory.entries");
      const [before] = await tx
        .select()
        .from(core)
        .where(and(eq(core.id, seen.id), eq(core.status, "active")));
      if (before?.section === "instructions") {
        throw new MemoryRefusal(
          { code: "validation" },
          "Раздел «Указания» меняет только агент в ходе",
        );
      }
      if (before?.version !== seen.version) throw changedSince();
      const existing = await activeEntry(tx, title);
      if (existing) throw duplicate(existing);

      const [created] = await tx
        .insert(entries)
        .values({
          kind: input.kind,
          title,
          text: before.text,
          source: before.source,
          sourceMessageId: before.sourceMessageId,
          validUntil: before.validUntil,
        })
        .returning(entryColumns);
      if (!created) throw new Error("INSERT записи не вернул строку");
      const [after] = await tx
        .update(core)
        .set({
          status: "archived",
          version: sql`${core.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(core.id, before.id))
        .returning();
      await tx.insert(changes).values([
        {
          coreId: before.id,
          actor: "consolidator",
          action: "move",
          before,
          after,
        },
        {
          entryId: created.id,
          actor: "consolidator",
          action: "move",
          after: created,
        },
      ]);
      return { id: created.id };
    })
    .catch((cause: unknown) =>
      refusedOr(cause, "Не удалось перенести факт ядра в записи", title),
    );
}

/**
 * One UPDATE marks and returns the changes of the background, so a concurrent pass gets none of
 * them (П14, E5). The texts come from `after`: what the change wrote, not what the row holds now.
 */
export async function claimUnreported(): Promise<Error | ReportedChange[]> {
  return db
    .update(changes)
    .set({ reportedAt: sql`now()` })
    .where(
      and(
        isNull(changes.reportedAt),
        inArray(changes.actor, ["extractor", "consolidator"]),
      ),
    )
    .returning({
      id: changes.id,
      at: changes.at,
      action: changes.action,
      entryId: changes.entryId,
      title: sql<string | null>`${changes.after}->>'title'`,
      text: sql<string | null>`${changes.after}->>'text'`,
      status: sql<string | null>`${changes.after}->>'status'`,
      keptTitle: sql<
        string | null
      >`(select kept.title from ${entries} as kept where kept.id::text = ${changes.after}->>'supersededBy')`,
    })
    .catch(
      (cause: unknown) =>
        new Error("Не удалось отметить изменения для отчёта", { cause }),
    );
}

export async function unclaim(ids: string[]): Promise<Error | undefined> {
  const released = await db
    .update(changes)
    .set({ reportedAt: null })
    .where(inArray(changes.id, ids))
    .catch(
      (cause: unknown) =>
        new Error("Не удалось снять отметку отчёта", { cause }),
    );
  if (released instanceof Error) return released;
}

/** Postgres `char_length` in the CHECKs counts code points, not UTF-16 units. */
export function charLength(text: string): number {
  return [...text].length;
}

/** An expired row stays active until the night pass archives it (П7). */
function unexpired(
  validUntil: typeof entries.validUntil | typeof core.validUntil,
): SQL {
  return sql`(${validUntil} is null or ${validUntil} > now())`;
}

function expired(
  validUntil: typeof entries.validUntil | typeof core.validUntil,
): SQL {
  return sql`${validUntil} <= now()`;
}

function changedSince(): MemoryRefusal {
  return new MemoryRefusal(
    { code: "conflict" },
    "Запись или факт ядра изменились после того, как ночь их прочитала",
  );
}

function sameText(
  column: typeof entries.title | typeof core.text,
  text: string,
): SQL {
  return sql`lower(${column} COLLATE "und-x-icu") = lower(${text}::text COLLATE "und-x-icu")`;
}

function checkFact(text: string): MemoryRefusal | undefined {
  if (charLength(text) > TEXT_MAX) {
    return new MemoryRefusal(
      { code: "too_long" },
      `Факт ядра — не длиннее ${TEXT_MAX} символов`,
    );
  }
  if (!text) {
    return new MemoryRefusal({ code: "validation" }, "Пустой факт ядра");
  }
  return undefined;
}

async function sourceMessage(
  tx: Tx,
  messageId: string,
): Promise<MemoryRefusal | { createdAt: Date }> {
  const [message] = await tx
    .select({
      role: sql<string | null>`${messages.uiMessage}->>'role'`,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.id, messageId));
  if (message?.role !== "user") {
    return new MemoryRefusal(
      { code: "no_source" },
      "Источник записи — только сообщение владельца",
    );
  }
  return message;
}

async function forgottenTitle(
  tx: Tx,
  title: string,
  source: { createdAt: Date },
): Promise<MemoryRefusal | undefined> {
  const [archived] = await tx
    .select({ id: entries.id, archivedAt: changes.at })
    .from(entries)
    .innerJoin(changes, eq(changes.entryId, entries.id))
    .where(
      and(
        eq(entries.status, "archived"),
        sameText(entries.title, title),
        inArray(changes.action, ["archive", "merge", "move"]),
      ),
    )
    .orderBy(desc(changes.at))
    .limit(1);
  if (archived && archived.archivedAt > source.createdAt) {
    return new MemoryRefusal(
      { code: "archived", ...archived },
      `Запись «${title}» забыта позже этого сообщения; вернуть её можно только memory_restore`,
    );
  }
  return undefined;
}

/**
 * The processing reads an older conversation after the owner may have forgotten what it says, and
 * names a fact in its own words (П21). The agent writes by the message of its own turn and may
 * remove a core fact and save an entry about the same in that turn.
 */
async function forgottenForProcessing(
  tx: Tx,
  title: string,
  source: { id: string; createdAt: Date },
): Promise<MemoryRefusal | undefined> {
  const archived = inArray(changes.action, ["archive", "merge", "move"]);
  const [named] = await tx
    .select({ id: core.id, archivedAt: changes.at })
    .from(core)
    .innerJoin(changes, eq(changes.coreId, core.id))
    .where(
      and(
        eq(core.status, "archived"),
        sql`strpos(lower(${core.text} COLLATE "und-x-icu"), lower(${title}::text COLLATE "und-x-icu")) > 0`,
        archived,
      ),
    )
    .orderBy(desc(changes.at))
    .limit(1);
  if (named && named.archivedAt > source.createdAt) {
    return new MemoryRefusal(
      { code: "archived", ...named },
      `Факт ядра о «${title}» убран позже этого сообщения`,
    );
  }
  const [entry] = await tx
    .select({ id: entries.id, archivedAt: changes.at })
    .from(entries)
    .innerJoin(changes, eq(changes.entryId, entries.id))
    .where(
      and(
        eq(entries.status, "archived"),
        eq(entries.sourceMessageId, source.id),
        archived,
      ),
    )
    .orderBy(desc(changes.at))
    .limit(1);
  const [fact] = await tx
    .select({ id: core.id, archivedAt: changes.at })
    .from(core)
    .innerJoin(changes, eq(changes.coreId, core.id))
    .where(
      and(
        eq(core.status, "archived"),
        eq(core.sourceMessageId, source.id),
        archived,
      ),
    )
    .orderBy(desc(changes.at))
    .limit(1);
  const taken = entry ?? fact;
  if (!taken) return undefined;
  return new MemoryRefusal(
    { code: "archived", ...taken },
    "Из этого сообщения память уже записывалась и была забыта",
  );
}

async function forgottenFact(
  tx: Tx,
  text: string,
  source: { createdAt: Date },
): Promise<MemoryRefusal | undefined> {
  const [archived] = await tx
    .select({ id: core.id, archivedAt: changes.at })
    .from(core)
    .innerJoin(changes, eq(changes.coreId, core.id))
    .where(
      and(
        eq(core.status, "archived"),
        sameText(core.text, text),
        inArray(changes.action, ["archive", "merge", "move"]),
      ),
    )
    .orderBy(desc(changes.at))
    .limit(1);
  if (archived && archived.archivedAt > source.createdAt) {
    return new MemoryRefusal(
      { code: "archived", ...archived },
      "Этот факт убран из ядра позже этого сообщения",
    );
  }
  return undefined;
}

async function activeEntry(
  tx: Tx | typeof db,
  title: string,
): Promise<{ id: string; version: number; text: string } | undefined> {
  const [row] = await tx
    .select({ id: entries.id, version: entries.version, text: entries.text })
    .from(entries)
    .where(and(eq(entries.status, "active"), sameText(entries.title, title)));
  return row;
}

function duplicate(existing: {
  id: string;
  version: number;
  text: string;
}): MemoryRefusal {
  return new MemoryRefusal(
    { code: "duplicate", ...existing },
    "Запись с таким названием уже есть: обнови её, передав id и version",
  );
}

function entryNotFound(
  id: string,
  among: "активных" | "забытых",
): MemoryRefusal {
  return new MemoryRefusal(
    { code: "not_found" },
    `Записи ${id} нет среди ${among}`,
  );
}

/**
 * Writes of one table run one after another: the 3000-character sum of the core (П5, E13) and
 * the archive check of П21 against a concurrent forget hold only under this lock.
 */
async function lock(
  tx: Tx,
  table: "memory.core" | "memory.entries",
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${table}::text))`);
}

type QuotedFact = { row: typeof core.$inferSelect; quoted: boolean };

/**
 * The context writes `<` as `<\` (П15), so a fact matches the quote as it is or with `<\` read as
 * `<` (П20): facts that look the same in the context then come out ambiguous, and neither changes.
 */
async function coreFacts(tx: Tx, old = ""): Promise<QuotedFact[]> {
  const quote = old
    .trim()
    .replace(/^<fact\b[^>]*>/, "")
    .replace(/<\/fact>$/, "")
    .trim();
  const contains = (part: string) =>
    sql`strpos(lower(${core.text} COLLATE "und-x-icu"), lower(${part}::text COLLATE "und-x-icu")) > 0`;
  return tx
    .select({
      row: core,
      quoted: sql<boolean>`${quote}::text <> '' and (${contains(quote)} or ${contains(quote.replaceAll("<\\", "<"))})`,
    })
    .from(core)
    .where(and(eq(core.status, "active"), unexpired(core.validUntil)))
    .orderBy(asc(core.id));
}

function quotedFact(facts: QuotedFact[]): MemoryRefusal | QuotedFact {
  const quoted = facts.filter((fact) => fact.quoted);
  const [only] = quoted;
  if (!only) {
    return new MemoryRefusal(
      { code: "not_found", facts: facts.map((fact) => fact.row.text) },
      "Ни один факт ядра не содержит эту цитату; процитируй слова одного факта",
    );
  }
  if (quoted.length > 1) {
    return new MemoryRefusal(
      { code: "ambiguous", facts: quoted.map((fact) => fact.row.text) },
      "Цитата есть в нескольких фактах ядра; процитируй слова, которые есть только в одном",
    );
  }
  return only;
}

function usedBy(facts: QuotedFact[]): number {
  return facts.reduce((sum, fact) => sum + charLength(fact.row.text), 0);
}

function coreFull(facts: QuotedFact[]): MemoryRefusal {
  return new MemoryRefusal(
    {
      code: "core_full",
      used: usedBy(facts),
      facts: facts.map((fact) => fact.row.text),
    },
    `В ядре не больше ${CORE_MAX} символов: ужми или убери факты`,
  );
}

/**
 * A rename has no duplicate check before its UPDATE, so the unique index reports the taken title.
 * The processing reads its owner through `reader`, its own transaction: its earlier operation may
 * hold the title uncommitted.
 */
async function refusedOr(
  cause: unknown,
  failure: string,
  title?: string,
  reader: Tx | typeof db = db,
): Promise<Error> {
  if (cause instanceof MemoryRefusal) return cause;
  const constraint = violatedConstraint(cause);
  if (constraint === "entries_active_title_uq" && title !== undefined) {
    const existing = await activeEntry(reader, title).catch(() => undefined);
    if (existing) return duplicate(existing);
  }
  if (constraint === "entries_plan_valid_until_check") {
    return new MemoryRefusal(
      { code: "validation" },
      "У плана (kind plan) должен быть срок validUntil",
    );
  }
  return new Error(failure, { cause });
}

function violatedConstraint(error: unknown): string | undefined {
  for (
    let current: unknown = error;
    current instanceof Error;
    current = current.cause
  ) {
    if ("constraint" in current && typeof current.constraint === "string") {
      return current.constraint;
    }
  }
  return undefined;
}
