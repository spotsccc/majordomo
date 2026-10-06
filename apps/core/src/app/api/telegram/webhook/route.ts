import { createHandler } from "@repo/handler";
import { after } from "next/server";
import { getBot } from "@/lib/telegram/bot";

/** The agent answers in `after`, within this limit; Vercel Hobby allows at most 300 s. */
export const maxDuration = 300;

/**
 * Telegram webhook. The adapter checks `X-Telegram-Bot-Api-Secret-Token`
 * (401 when it is wrong) and the owner's id, answers 200 right away and runs
 * the handlers in `after`, so Telegram does not resend the update while the
 * agent answers. The route has no body schema: the adapter reads the body
 * itself. Without the bot's variables (Preview, local) it answers 500; the
 * webhook is registered only for Production.
 */
export const POST = createHandler({}, async ({ request }) => {
  const bot = getBot();
  if (bot instanceof Error) throw bot;

  return bot.webhooks.telegram(request, {
    waitUntil: (task) => after(() => task),
  });
});
