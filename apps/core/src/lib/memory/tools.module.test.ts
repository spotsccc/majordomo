import { format } from "node:util";
import { core, entries } from "@repo/db";
import type { ToolSet } from "ai";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Turn } from "../capability";
import { db } from "../db";
import { ownerTurn, resetMemory } from "./memory.test-utils";
import { memoryCapability } from "./tools";

/** The owner's zone is read once, when `config` loads, so the tools load again with it. */
async function toolsInBuenosAires(turn: Turn): Promise<ToolSet> {
  vi.stubEnv("OWNER_TIME_ZONE", "America/Argentina/Buenos_Aires");
  vi.resetModules();
  const tools = await import("./tools");
  return tools.memoryCapability.tools(turn);
}

async function call(
  tools: ToolSet,
  name: string,
  input: unknown,
): Promise<unknown> {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error(`В наборе нет тула ${name}`);
  return execute(input, {
    toolCallId: `call_${name}`,
    messages: [],
    context: undefined,
  });
}

beforeEach(async () => {
  await resetMemory();
});

describe("memory tools", () => {
  it("memory_save and core_add write rows with the owner's message of the turn as the source, and validUntil as the end of that day in Buenos Aires", async () => {
    const turn = await ownerTurn(
      "Запомни: в Мадриде до 20 октября, отвечай коротко",
    );
    const tools = await toolsInBuenosAires(turn);

    const saved = await call(tools, "memory_save", {
      kind: "plan",
      title: "Мадрид",
      text: "командировка до 20 октября",
      validUntil: "2026-10-20",
    });
    const added = await call(tools, "core_add", {
      section: "instructions",
      text: "Отвечай коротко",
    });

    expect(saved).toEqual({ id: expect.any(String), version: 1 });
    expect(added).toEqual({ used: "Отвечай коротко".length });
    expect(
      await db
        .select({
          title: entries.title,
          validUntil: entries.validUntil,
          sourceMessageId: entries.sourceMessageId,
        })
        .from(entries),
    ).toEqual([
      {
        title: "Мадрид",
        validUntil: new Date("2026-10-21T03:00:00Z"),
        sourceMessageId: turn.messageId,
      },
    ]);
    expect(
      await db
        .select({
          section: core.section,
          text: core.text,
          sourceMessageId: core.sourceMessageId,
        })
        .from(core),
    ).toEqual([
      {
        section: "instructions",
        text: "Отвечай коротко",
        sourceMessageId: turn.messageId,
      },
    ]);
  });

  it("memory_search answers validUntil as the owner's last day, and saving that day back keeps valid_until", async () => {
    const tools = await toolsInBuenosAires(
      await ownerTurn("Запомни: в Мадриде до 20 октября 2099 года"),
    );
    await call(tools, "memory_save", {
      kind: "plan",
      title: "Мадрид",
      text: "командировка до 20 октября",
      validUntil: "2099-10-20",
    });

    const found = await call(tools, "memory_search", { query: "Мадрид" });

    expect(found).toEqual([
      {
        id: expect.any(String),
        version: 1,
        kind: "plan",
        title: "Мадрид",
        text: "командировка до 20 октября",
        validUntil: "2099-10-20",
        status: "active",
        updatedAt: expect.any(Date),
      },
    ]);
    const [seen] = z
      .tuple([
        z.object({ id: z.string(), version: z.int(), validUntil: z.string() }),
      ])
      .parse(found);
    await call(tools, "memory_save", {
      ...seen,
      kind: "plan",
      title: "Мадрид",
      text: "командировка до 20 октября, отель у Ретиро",
    });
    expect(
      await db
        .select({ version: entries.version, validUntil: entries.validUntil })
        .from(entries),
    ).toEqual([{ version: 2, validUntil: new Date("2099-10-21T03:00:00Z") }]);
  });

  it("returns a refused write as the value { error: { code } } and writes nothing", async () => {
    const tools = memoryCapability.tools(await ownerTurn("Запомни"));

    const saved = await call(tools, "memory_save", {
      kind: "person",
      title: "Маша",
      text: "ж".repeat(301),
    });
    const removed = await call(tools, "core_remove", {
      old: "пионы",
      reason: "разлюбила",
    });

    expect(saved).toEqual({
      error: { code: "too_long", message: expect.any(String) },
    });
    expect(removed).toEqual({
      error: { code: "not_found", facts: [], message: expect.any(String) },
    });
    expect(await db.select().from(entries)).toEqual([]);
  });

  it("logs a database failure of memory_save and memory_search without the text of the memory and answers internal", async () => {
    const tools = memoryCapability.tools(await ownerTurn("Запомни"));
    let output = "";
    const logged = vi.spyOn(console, "error").mockImplementation((...args) => {
      output += format(...args);
    });

    await db.execute(sql`ALTER SCHEMA memory RENAME TO memory_hidden`);
    let saved: unknown;
    let found: unknown;
    try {
      saved = await call(tools, "memory_save", {
        kind: "person",
        title: "Тайная Маша",
        text: "секретный текст",
      });
      found = await call(tools, "memory_search", { query: "Тайная Маша" });
    } finally {
      logged.mockRestore();
      await db.execute(sql`ALTER SCHEMA memory_hidden RENAME TO memory`);
    }

    expect(saved).toEqual({
      error: { code: "internal", message: expect.any(String) },
    });
    expect(found).toEqual({
      error: { code: "internal", message: expect.any(String) },
    });
    expect(output).toContain("Не удалось сохранить запись");
    expect(output).toContain("Не удалось найти записи");
    expect(output).not.toContain("Тайная Маша");
    expect(output).not.toContain("секретный текст");
  });

  it("gives a turn without a conversation only memory_search", () => {
    expect(Object.keys(memoryCapability.tools(undefined))).toEqual([
      "memory_search",
    ]);
  });
});
