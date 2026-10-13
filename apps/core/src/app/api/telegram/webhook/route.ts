import { createHandler } from "@repo/handler";
import { after } from "next/server";
import { getBot } from "@/lib/telegram/bot";

/** The agent answers in `after`, within this limit; Vercel Hobby allows at most 300 s. */
export const maxDuration = 300;

/**
 * Answers 200 right away and runs the handlers in `after`, so Telegram does not resend the
 * update while the agent answers. No body schema: the adapter reads the body itself.
 */
export const POST = createHandler({}, async ({ request }) => {
  const bot = getBot();
  if (bot instanceof Error) throw bot;

  return bot.webhooks.telegram(request, {
    waitUntil: (task) => after(() => task),
  });
});
