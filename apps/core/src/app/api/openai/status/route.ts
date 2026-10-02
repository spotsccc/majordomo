import { createHandler } from "@repo/handler";
import { requireOwner } from "@/lib/auth";
import { createOpenAIAuth } from "@/lib/openai";

/** Session state: logged_out, active or reauth_required, with account and expiry. */
export const GET = createHandler({}, async ({ request }) => {
  requireOwner(request);
  return Response.json(await createOpenAIAuth().status());
});
