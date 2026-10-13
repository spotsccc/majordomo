import { createHandler } from "@repo/handler";
import { requireCron } from "@/lib/auth";
import { createOpenAIAuth } from "@/lib/openai";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Requests refresh an expiring token themselves; this keeps the session alive while nobody uses
 * the assistant. `aheadMs` covers Hobby's ±1 h cron precision.
 */
export const GET = createHandler({ guards: [requireCron] }, async () => {
  const result = await createOpenAIAuth().refreshIfDue({
    aheadMs: DAY + 2 * 60 * 60 * 1000,
  });
  if (result instanceof Error) throw result;

  return Response.json(result);
});
