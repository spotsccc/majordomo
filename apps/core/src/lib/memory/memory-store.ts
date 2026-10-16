import {
  changes,
  core,
  entries,
  messages,
  type CoreSection,
  type EntryKind,
} from "@repo/db";
import { createTaggedError } from "@spotsccc/error-as-value";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Turn } from "../capability";
import { db } from "../db";

const TITLE_MAX = 60;

const TEXT_MAX = 300;

const CORE_MAX = 3000;

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
  section: CoreSection;
  text: string;
  updatedAt: Date;
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
 * An edit checks П21 only when it changes the title beyond case: otherwise the entry already holds
 * that title, and nothing forgotten comes back.
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
): Promise<Error | { id: string; version: number }> {
  const title = input.title.trim();
  const text = input.text.trim();
  if (length(title) > TITLE_MAX || length(text) > TEXT_MAX) {
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
  const values = {
    kind: input.kind,
    title,
    text,
    validUntil: input.validUntil ?? null,
    source: "owner" as const,
    sourceMessageId: turn.messageId,
  };

  return db
    .transaction(async (tx) => {
      await lock(tx, "memory.entries");
      const message = await sourceMessage(tx, turn.messageId);
      if (message instanceof Error) throw message;

      if (id === undefined || version === undefined) {
        const forgotten = await forgottenTitle(tx, title, message);
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
          actor: "agent",
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
        actor: "agent",
        action: "update",
        before,
        after,
        conversationId: turn.conversationId,
      });
      return { id, version: after.version };
    })
    .catch((cause: unknown) =>
      refusedOr(cause, "Не удалось сохранить запись", title),
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

export async function restoreEntry(
  id: string,
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
      const existing = await activeEntry(tx, before.title);
      if (existing) throw duplicate(existing);

      const [after] = await tx
        .update(entries)
        .set({
          status: "active",
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
 * The words of the query are joined with OR: with AND a natural question finds nothing (spike
 * results, item 3). A use is not a change of the entry, so `version` and `updated_at` stay.
 */
export async function searchEntries(
  query: string,
  { includeArchived = false }: { includeArchived?: boolean } = {},
): Promise<Error | Entry[]> {
  const words = sql`(
    select string_agg('''' || replace(replace(word, '\\', '\\\\'), '''', '''''') || '''', ' | ')::tsquery
      from unnest(tsvector_to_array(to_tsvector('russian', lower(${query}::text COLLATE "und-x-icu")))) as word
  )`;
  const found = await db
    .select(entryFields)
    .from(entries)
    .where(
      and(
        sql`${entries.search} @@ ${words}`,
        includeArchived ? undefined : eq(entries.status, "active"),
        unexpired(entries.validUntil),
      ),
    )
    .orderBy(
      sql`ts_rank(${entries.search}, ${words}) desc`,
      desc(entries.updatedAt),
    )
    .limit(SEARCH_LIMIT)
    .catch((cause: unknown) => new Error("Не удалось найти записи", { cause }));
  if (found instanceof Error || found.length === 0) return found;

  const counted = await db
    .update(entries)
    .set({ useCount: sql`${entries.useCount} + 1`, lastUsedAt: sql`now()` })
    .where(
      inArray(
        entries.id,
        found.map((entry) => entry.id),
      ),
    )
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
      const archived = await archivedCoreFact(tx, text);
      if (archived && archived.archivedAt > message.createdAt) {
        throw new MemoryRefusal(
          { code: "archived", ...archived },
          "Этот факт убран из ядра позже этого сообщения",
        );
      }
      const facts = await coreFacts(tx);
      const used = usedBy(facts) + length(text);
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
      const used = usedBy(facts) - length(before.row.text) + length(text);
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

export async function listActive(): Promise<
  Error | { core: CoreFact[]; entries: Entry[] }
> {
  const [facts, active] = await Promise.all([
    db
      .select({
        id: core.id,
        section: core.section,
        text: core.text,
        updatedAt: core.updatedAt,
      })
      .from(core)
      .where(and(eq(core.status, "active"), unexpired(core.validUntil)))
      .orderBy(asc(core.id))
      .catch(
        (cause: unknown) => new Error("Не удалось прочитать ядро", { cause }),
      ),
    db
      .select(entryFields)
      .from(entries)
      .where(and(eq(entries.status, "active"), unexpired(entries.validUntil)))
      .orderBy(sql`${entries.title} COLLATE "und-x-icu"`)
      .catch(
        (cause: unknown) => new Error("Не удалось прочитать записи", { cause }),
      ),
  ]);
  if (facts instanceof Error) return facts;
  if (active instanceof Error) return active;
  return { core: facts, entries: active };
}

/** Postgres `char_length` in the CHECKs counts code points, not UTF-16 units. */
function length(text: string): number {
  return [...text].length;
}

/** An expired row stays active until the night pass archives it (П7). */
function unexpired(
  validUntil: typeof entries.validUntil | typeof core.validUntil,
): SQL {
  return sql`(${validUntil} is null or ${validUntil} > now())`;
}

function sameText(
  column: typeof entries.title | typeof core.text,
  text: string,
): SQL {
  return sql`lower(${column} COLLATE "und-x-icu") = lower(${text}::text COLLATE "und-x-icu")`;
}

function checkFact(text: string): MemoryRefusal | undefined {
  if (length(text) > TEXT_MAX) {
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

async function archivedCoreFact(
  tx: Tx,
  text: string,
): Promise<{ id: number; archivedAt: Date } | undefined> {
  const [row] = await tx
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
  return row;
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

/** П20: a `<fact …>` tag the model copied from the context is not part of the quote. */
async function coreFacts(tx: Tx, old = ""): Promise<QuotedFact[]> {
  const quote = old
    .trim()
    .replace(/^<fact\b[^>]*>/, "")
    .replace(/<\/fact>$/, "")
    .trim();
  return tx
    .select({
      row: core,
      quoted: sql<boolean>`${quote}::text <> '' and strpos(lower(${core.text} COLLATE "und-x-icu"), lower(${quote}::text COLLATE "und-x-icu")) > 0`,
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
  return facts.reduce((sum, fact) => sum + length(fact.row.text), 0);
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
 * A concurrent write can take the title after the check, and only the CHECK knows that a plan
 * needs `valid_until`.
 */
async function refusedOr(
  cause: unknown,
  failure: string,
  title?: string,
): Promise<Error> {
  if (cause instanceof MemoryRefusal) return cause;
  const constraint = violatedConstraint(cause);
  if (constraint === "entries_active_title_uq" && title !== undefined) {
    const existing = await activeEntry(db, title).catch(() => undefined);
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
