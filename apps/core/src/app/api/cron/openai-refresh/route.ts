import { createHandler } from "@repo/handler";
import { requireCron } from "@/lib/auth";
import { createOpenAIAuth } from "@/lib/openai";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Daily Vercel Cron (see vercel.json). Requests refresh an expiring token
 * themselves; this keeps the session alive while nobody uses the assistant.
 * Refreshes anything that would be due before the next run (with slack for
 * Hobby's ±1 h cron precision).
 */
export const GET = createHandler({}, async ({ request }) => {
  requireCron(request);
  const result = await createOpenAIAuth().refreshIfDue({
    aheadMs: DAY + 2 * 60 * 60 * 1000,
  });
  return Response.json(result);
});
