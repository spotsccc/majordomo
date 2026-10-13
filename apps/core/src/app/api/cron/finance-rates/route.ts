import { createHandler } from "@repo/handler";
import { requireCron } from "@/lib/auth";
import { fetchRates } from "@/lib/finance/rates";

/** A currency CoinGecko did not price is not a failure: `missing` names it in the Vercel logs. */
export const GET = createHandler({ guards: [requireCron] }, async () => {
  const result = await fetchRates();
  if (result instanceof Error) throw result;

  return Response.json(result);
});
