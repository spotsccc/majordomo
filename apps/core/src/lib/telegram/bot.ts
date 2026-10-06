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
 * The owner's Telegram bot on Chat SDK, built on the first call in a function
 * instance and reused after that. Nothing is built when the module loads:
 * `next build` loads the webhook route, and Preview has no bot. Returns an
 * `Error` when the token, the webhook secret or the owner id is not set: the
 * bot never starts with an empty allowlist, which would let everyone in.
 *
 * Every adapter option that has an environment variable is passed from
 * `config`. Left out, the adapter reads its own variables
 * (`TELEGRAM_ALLOWED_USER_IDS`, `TELEGRAM_ALLOW_UNVERIFIED_WEBHOOKS`,
 * `TELEGRAM_API_BASE_URL` and others) past the config check. `mode:
 * "webhook"` keeps a local server from polling Telegram.
 *
 * Chat SDK keeps its state (locks, the queue, deduplication) in the
 * `chat_state_*` tables of `public` on the application pool, and the adapter
 * creates them when it connects, on every cold start (`CREATE … IF NOT
 * EXISTS`); docs/architecture/database.md lists the exception. The `queue`
 * strategy collects the messages that arrive during a turn and answers them
 * with one turn after it. Queued messages live 10 minutes, longer than a
 * turn; the default 90 s is shorter.
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
