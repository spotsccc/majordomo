import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Capability, Turn } from "../capability";
import { ownerDayRange, ownerLastDay } from "../owner-time";
import { readConversation, searchHistory } from "./history";
import { logFailure } from "./log";
import {
  addCoreFact,
  forgetEntry,
  MemoryRefusal,
  removeCoreFact,
  replaceCoreFact,
  restoreEntry,
  saveEntry,
  searchEntries,
  type Refusal,
} from "./memory-store";

const ValidUntil = z.iso
  .date()
  .describe(
    "последний день, когда это верно, YYYY-MM-DD в часовом поясе владельца; без него — бессрочно",
  );

const Quote = z
  .string()
  .describe("слова, которые есть только в этом факте ядра, как в контексте");

type ToolError = {
  error: (Refusal | { code: "internal" }) & { message: string };
};

function result<T>(value: Error | T): T | ToolError {
  if (!(value instanceof Error)) return value;
  if (value instanceof MemoryRefusal) {
    return { error: { ...value.refusal, message: value.message } };
  }
  logFailure("Тул памяти: сбой", value);
  return {
    error: { code: "internal", message: "Внутренняя ошибка, попробуйте позже" },
  };
}

function endOf(day: string | undefined): Date | undefined {
  return day === undefined ? undefined : ownerDayRange(day).to;
}

/**
 * `validUntil` goes out as the owner's last day, the inverse of `endOf`: the model copies it back
 * into `memory_save`, which replaces the whole entry, and the stored instant, the start of the next
 * day, would move the expiry a day later on every save.
 */
const memorySearch = tool({
  description:
    "Ищет записи памяти: находит запись, где есть хотя бы одно слово запроса. До 8 записей целиком.",
  inputSchema: z.strictObject({
    query: z.string(),
    includeArchived: z
      .boolean()
      .optional()
      .describe("и забытые записи из архива"),
  }),
  execute: async ({ query, includeArchived }) => {
    const found = await searchEntries(query, { includeArchived });
    return result(
      found instanceof Error
        ? found
        : found.map(({ validUntil, ...entry }) => ({
            ...entry,
            validUntil: validUntil && ownerLastDay(validUntil),
          })),
    );
  },
});

/** Every write needs the owner's message of this turn as its source (П1), so only a turn has them. */
function writeTools(turn: Turn): ToolSet {
  return {
    memory_save: tool({
      description:
        "Создаёт запись памяти. С id и version из memory_search или из ошибки duplicate заменяет запись целиком.",
      inputSchema: z.strictObject({
        id: z.uuid().optional(),
        version: z
          .int()
          .optional()
          .describe("version записи, которую ты видел; вместе с id"),
        kind: z
          .enum(["person", "preference", "fact", "plan"])
          .describe(
            "person — о человеке, preference — предпочтение, fact — факт, plan — план со сроком",
          ),
        title: z
          .string()
          .describe(
            "название до 60 символов: «Маша», «Квартира в Буэнос-Айресе»",
          ),
        text: z
          .string()
          .describe(
            "до 300 символов, продолжает название: «жена, день рождения 14 марта»",
          ),
        validUntil: ValidUntil.optional().describe(
          "последний день, когда запись верна, YYYY-MM-DD в часовом поясе владельца; у plan обязателен",
        ),
      }),
      execute: async ({ validUntil, ...input }) =>
        result(
          await saveEntry({ ...input, validUntil: endOf(validUntil) }, turn),
        ),
    }),

    memory_forget: tool({
      description: "Убирает запись в архив; вернуть её можно memory_restore.",
      inputSchema: z.strictObject({
        id: z.uuid(),
        reason: z.string().describe("почему, словами"),
      }),
      execute: async ({ id, reason }) =>
        result(await forgetEntry(id, reason, turn)),
    }),

    memory_restore: tool({
      description: "Возвращает забытую запись из архива.",
      inputSchema: z.strictObject({ id: z.uuid() }),
      execute: async ({ id }) => result(await restoreEntry(id, turn)),
    }),

    core_add: tool({
      description:
        "Добавляет факт в ядро — память, которая видна в каждом разговоре. Возвращает, сколько из 3000 символов ядра занято.",
      inputSchema: z.strictObject({
        section: z
          .enum(["instructions", "profile"])
          .describe(
            "instructions — указание тебе от владельца, profile — о владельце и важном для него",
          ),
        text: z.string().describe("до 300 символов, можно в несколько строк"),
        validUntil: ValidUntil.optional(),
      }),
      execute: async ({ validUntil, ...input }) =>
        result(
          await addCoreFact({ ...input, validUntil: endOf(validUntil) }, turn),
        ),
    }),

    core_replace: tool({
      description:
        "Заменяет факт ядра целиком новым текстом; факт находит по цитате old.",
      inputSchema: z.strictObject({
        old: Quote,
        text: z.string().describe("новый текст факта целиком, до 300 символов"),
        validUntil: ValidUntil.optional(),
      }),
      execute: async ({ old, text, validUntil }) =>
        result(
          await replaceCoreFact(
            old,
            { text, validUntil: endOf(validUntil) },
            turn,
          ),
        ),
    }),

    core_remove: tool({
      description:
        "Убирает факт ядра в архив; факт находит по цитате old. Возвращает текст убранного факта.",
      inputSchema: z.strictObject({
        old: Quote,
        reason: z.string().describe("почему, словами"),
      }),
      execute: async ({ old, reason }) =>
        result(await removeCoreFact(old, reason, turn)),
    }),
  };
}

export const memoryCapability: Capability = {
  name: "memory",
  rules: [
    "Запоминай, что владелец сказал о себе, о людях, планах и предпочтениях. Указание со словами «всегда», «впредь» сохраняй в ядро, в раздел «Указания».",
    "Что нужно почти в каждом разговоре, пиши в ядро (core_add), остальное — записью (memory_save). Перед новой записью найди похожую через memory_search; если она есть, обнови её.",
    "Факт ядра меняй и убирай по куску его текста (core_replace, core_remove): процитируй слова, которые есть только в этом факте.",
    "О людях, планах и фактах, которых нет в ядре, сначала спроси memory_search.",
    "Деньги в память не пиши: остатки и операции — в тулах учёта.",
    "После записи скажи, что запомнил. Если memory_save среди тулов нет, скажи, что запомнить можно в Telegram.",
    "Запись старше 30 дней могла устареть. Если это важно, уточни у владельца.",
  ],
  tools: (turn) =>
    turn
      ? { memory_search: memorySearch, ...writeTools(turn) }
      : { memory_search: memorySearch },
};

const Day = z.iso.date();

const historyTools: ToolSet = {
  history_search: tool({
    description:
      "Ищет прошлые разговоры с владельцем: находит разговор, где есть хотя бы одно слово запроса в названии, сводке или сообщениях. До 5 разговоров со сводкой и совпавшими сообщениями. Если в днях from–to ничего нет, ищет во все дни и отвечает outsideRange: true.",
    inputSchema: z.strictObject({
      query: z.string(),
      from: Day.optional().describe(
        "первый день, YYYY-MM-DD в часовом поясе владельца",
      ),
      to: Day.optional().describe(
        "последний день, YYYY-MM-DD в часовом поясе владельца",
      ),
    }),
    execute: async (input) => result(await searchHistory(input)),
  }),
  conversation_read: tool({
    description:
      "Читает кусок прошлого разговора: сводку и до 20 сообщений вокруг aroundSeq, без него — последние.",
    inputSchema: z.strictObject({
      conversationId: z.uuid(),
      aroundSeq: z
        .int()
        .optional()
        .describe("seq совпавшего сообщения из history_search"),
    }),
    execute: async ({ conversationId, aroundSeq }) => {
      const read = await readConversation(conversationId, aroundSeq);
      return read === null
        ? {
            error: {
              code: "not_found" as const,
              message: `Разговора ${conversationId} нет`,
            },
          }
        : result(read);
    },
  }),
};

/** Past conversations are stored only in Telegram, so the web chat has no history tools. */
export const historyCapability: Capability = {
  name: "history",
  rules: [
    "О прошлых разговорах сначала вызови history_search. Не нашёл — так и скажи. Пусто — перефразируй запрос и поищи ещё раз.",
  ],
  tools: (turn) => (turn ? historyTools : {}),
};
