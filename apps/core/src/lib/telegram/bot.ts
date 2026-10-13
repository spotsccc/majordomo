import { createPostgresState } from "@chat-adapter/state-pg";
import {
  createTelegramAdapter,
  type TelegramAdapter,
} from "@chat-adapter/telegram";
import { Chat } from "chat";
import { config } from "../config";
import { pool } from "../db";
import { handleOwnerMessages, handleSlashCommand } from "./handlers";

type Bot = Chat<{ telegram: TelegramAdapter }>;

let bot: Bot | undefined;

/**
 * Nothing is built when the module loads: `next build` loads the webhook route, and Preview has
 * no bot. It never starts with an empty allowlist, which would let everyone in. Every adapter
 * option with an environment variable is passed from `config`; left out, the adapter reads its
 * own variables (`TELEGRAM_ALLOWED_USER_IDS` and others) past the config check. Queued messages
 * live 10 minutes, longer than a turn; the default 90 s is shorter.
 */
export function getBot(): Error | Bot {
  if (bot) return bot;

  const {
    TELEGRAM_BOT_TOKEN: botToken,
    TELEGRAM_WEBHOOK_SECRET: secretToken,
    TELEGRAM_OWNER_ID: ownerId,
    TELEGRAM_BOT_USERNAME: userName,
  } = config;
  if (!botToken || !secretToken || !ownerId) {
    return new Error(
      "Telegram-бот выключен: не заданы TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET или TELEGRAM_OWNER_ID",
    );
  }

  const chat = new Chat({
    userName: userName ?? "majordomo",
    adapters: {
      telegram: createTelegramAdapter({
        botToken,
        secretToken,
        allowedUserIds: [ownerId],
        allowUnverifiedWebhooks: false,
        mode: "webhook",
        userName,
        mentionOnReply: false,
        apiUrl: "https://api.telegram.org",
      }),
    },
    state: createPostgresState({ client: pool }),
    concurrency: {
      strategy: "queue",
      maxQueueSize: 20,
      queueEntryTtlMs: 600_000,
    },
  });
  chat.onDirectMessage((thread, message, _channel, context) =>
    handleOwnerMessages(thread, [...(context?.skipped ?? []), message]),
  );
  chat.onSlashCommand(handleSlashCommand);

  bot = chat;
  return bot;
}
