import type { TelegramMessage, TelegramUpdate } from "@chat-adapter/telegram";
import { conversations, messages, turns } from "@repo/db";
import type { WebhookOptions } from "chat";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { vi } from "vitest";
import { z } from "zod";
import { urlOf } from "../chatgpt.test-utils";
import { config } from "../config";
import { db } from "../db";
import { resetMemory } from "../memory/memory.test-utils";

const BOT_API = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/`;

const FILE_API = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/`;

export const VOICE_BYTES = new Uint8Array([
  0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00,
]);

export const OWNER_ID = Number(config.TELEGRAM_OWNER_ID);

export const STRANGER_ID = 777;

const BOT_USER = {
  id: 4242,
  is_bot: true,
  first_name: "Majordomo",
  username: config.TELEGRAM_BOT_USERNAME,
};

const BotApiParams = z.object({
  chat_id: z.coerce.number().optional(),
  file_id: z.string().optional(),
  message_id: z.number().optional(),
  text: z.string().optional(),
  parse_mode: z.string().optional(),
  rich_message: z.object({ markdown: z.string() }).optional(),
});

function visibleText(params: z.infer<typeof BotApiParams>): string {
  if (params.rich_message) return params.rich_message.markdown;
  const text = params.text ?? "";
  return params.parse_mode === "MarkdownV2"
    ? text.replace(/\\(.)/g, "$1")
    : text;
}

function ok(result: unknown): Response {
  return Response.json({ ok: true, result });
}

/**
 * Unimplemented methods are recorded in `unhandled` and answered 404, and the 400s the real Bot
 * API gives to an empty or unchanged text are recorded in `rejected`, so a test can fail on them
 * instead of the adapter logging them away.
 */
export class FakeTelegram {
  readonly unhandled: string[] = [];
  readonly rejected: string[] = [];
  downloads = 0;
  private readonly chats = new Map<number, { id: number; text: string }[]>();
  private nextMessageId = 1;

  handles(url: string): boolean {
    return url.startsWith(BOT_API) || url.startsWith(FILE_API);
  }

  answer(url: string, init?: RequestInit): Response {
    if (url.startsWith(FILE_API)) {
      this.downloads += 1;
      return new Response(VOICE_BYTES);
    }
    const method = url.slice(BOT_API.length);
    const params = BotApiParams.parse(
      typeof init?.body === "string" ? JSON.parse(init.body) : {},
    );
    const chat = this.messagesIn(params.chat_id ?? 0);
    switch (method) {
      case "getMe":
        return ok(BOT_USER);
      case "sendChatAction":
        return ok(true);
      case "getFile":
        return ok({
          file_id: params.file_id,
          file_unique_id: `unique-${params.file_id}`,
          file_size: VOICE_BYTES.length,
          file_path: `voice/${params.file_id}.oga`,
        });
      case "sendMessage":
      case "sendRichMessage": {
        if (!visibleText(params).trim()) {
          return this.reject(`${method}: message text is empty`);
        }
        const sent = { id: this.nextMessageId++, text: visibleText(params) };
        chat.push(sent);
        return ok(this.raw(params.chat_id ?? 0, sent));
      }
      case "editMessageText": {
        const edited = chat.find((message) => message.id === params.message_id);
        if (!edited) {
          return Response.json(
            {
              ok: false,
              error_code: 400,
              description: "Bad Request: message to edit not found",
            },
            { status: 400 },
          );
        }
        if (!visibleText(params).trim()) {
          return this.reject(`${method}: message text is empty`);
        }
        if (visibleText(params) === edited.text) {
          return this.reject(`${method}: message is not modified`);
        }
        edited.text = visibleText(params);
        return ok(this.raw(params.chat_id ?? 0, edited));
      }
      default:
        this.unhandled.push(method);
        return Response.json(
          { ok: false, error_code: 404, description: "Not Found" },
          { status: 404 },
        );
    }
  }

  private reject(description: string): Response {
    this.rejected.push(description);
    return Response.json(
      {
        ok: false,
        error_code: 400,
        description: `Bad Request: ${description}`,
      },
      { status: 400 },
    );
  }

  textsIn(chatId: number): string[] {
    return this.messagesIn(chatId).map((message) => message.text);
  }

  private messagesIn(chatId: number): { id: number; text: string }[] {
    const chat = this.chats.get(chatId) ?? [];
    this.chats.set(chatId, chat);
    return chat;
  }

  private raw(
    chatId: number,
    message: { id: number; text: string },
  ): TelegramMessage {
    return {
      message_id: message.id,
      date: 0,
      chat: { id: chatId, type: "private" },
      from: BOT_USER,
      text: message.text,
    };
  }
}

export function stubNetwork(
  telegram: FakeTelegram,
  other: (url: string, init?: RequestInit) => Response | Promise<Response>,
): void {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      return telegram.handles(url)
        ? telegram.answer(url, init)
        : other(url, init);
    },
  );
}

let nextUpdateId = 1;

/** Telegram gives a group a negative id and a private chat the id of its user. */
function update(
  chatId: number,
  content: Partial<TelegramMessage>,
  from = OWNER_ID,
): TelegramUpdate {
  const id = nextUpdateId++;
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat:
        chatId < 0
          ? { id: chatId, type: "group", title: "Группа" }
          : { id: chatId, type: "private", first_name: "Owner" },
      from: { id: from, is_bot: false, first_name: "Owner" },
      ...content,
    },
  };
}

export function textMessage(
  chatId: number,
  text: string,
  from = OWNER_ID,
): TelegramUpdate {
  return update(chatId, { text }, from);
}

export function commandMessage(
  chatId: number,
  command: string,
): TelegramUpdate {
  return update(chatId, {
    text: command,
    entities: [{ type: "bot_command", offset: 0, length: command.length }],
  });
}

export function photoMessage(chatId: number, caption?: string): TelegramUpdate {
  return update(chatId, {
    photo: [
      { file_id: "photo-1", file_unique_id: "p1", width: 90, height: 90 },
    ],
    caption,
  });
}

export function voiceMessage(
  chatId: number,
  {
    caption,
    size = VOICE_BYTES.length,
  }: { caption?: string; size?: number } = {},
): TelegramUpdate {
  return update(chatId, {
    voice: {
      file_id: "voice-1",
      file_unique_id: "v1",
      duration: 3,
      mime_type: "audio/ogg",
      file_size: size,
    },
    caption,
  });
}

export function webhookRequest(
  body: TelegramUpdate | string,
  secret: string | null = config.TELEGRAM_WEBHOOK_SECRET ?? null,
): Request {
  return new Request("https://example.test/api/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret === null ? {} : { "x-telegram-bot-api-secret-token": secret }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

type WebhookBot = {
  webhooks: {
    telegram: (request: Request, options?: WebhookOptions) => Promise<Response>;
  };
};

export async function deliverInBackground(
  bot: WebhookBot,
  update: TelegramUpdate,
): Promise<{ response: Response; handled: Promise<void> }> {
  const tasks: Promise<unknown>[] = [];
  const response = await bot.webhooks.telegram(webhookRequest(update), {
    waitUntil: (task) => {
      tasks.push(task);
    },
  });
  const handled = (async () => {
    for (let index = 0; index < tasks.length; index += 1) await tasks[index];
  })();
  return { response, handled };
}

export async function deliver(
  bot: WebhookBot,
  update: TelegramUpdate,
): Promise<Response> {
  const { response, handled } = await deliverInBackground(bot, update);
  await handled;
  return response;
}

/**
 * The Chat SDK state outlives a test file in the shared database; its tables exist only once a
 * bot has connected.
 */
export async function resetChats(): Promise<void> {
  await db.execute(sql`
    DO $$ BEGIN
      IF to_regclass('public.chat_state_cache') IS NOT NULL THEN
        TRUNCATE chat_state_subscriptions, chat_state_locks, chat_state_cache,
          chat_state_lists, chat_state_queues;
      END IF;
    END $$`);
  await resetMemory();
  await db.delete(turns);
  await db.delete(messages);
  await db.delete(conversations);
}

export async function turnsIn(
  chatId: number,
): Promise<{ status: string; error: string | null }[]> {
  return db
    .select({ status: turns.status, error: turns.error })
    .from(turns)
    .innerJoin(conversations, eq(turns.conversationId, conversations.id))
    .where(eq(conversations.externalId, `telegram:${chatId}`))
    .orderBy(asc(turns.startedAt));
}

export async function historyIn(chatId: number): Promise<string[]> {
  const rows = await db
    .select({ uiMessage: messages.uiMessage })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(
      and(
        eq(conversations.externalId, `telegram:${chatId}`),
        isNull(conversations.closedAt),
      ),
    )
    .orderBy(asc(messages.seq));
  return rows.map((row) =>
    row.uiMessage.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join(""),
  );
}
