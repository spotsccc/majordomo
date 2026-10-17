import { createHandler } from "@repo/handler";
import { requireCron } from "@/lib/auth";
import { consolidate } from "@/lib/memory/consolidate";

/** The pass keeps to its 240 s budget within this limit; Vercel Hobby allows at most 300 s. */
export const maxDuration = 300;

/** The result holds only counts, so it can go to the Vercel logs. */
export const GET = createHandler({ guards: [requireCron] }, async () => {
  const night = await consolidate();
  console.info("Ночной проход памяти", night);
  return Response.json(night);
});
