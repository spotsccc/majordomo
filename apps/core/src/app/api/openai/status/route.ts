import { createHandler } from "@repo/handler";
import { requireOwner } from "@/lib/auth";
import { createOpenAIAuth } from "@/lib/openai";

/** Session state: logged_out, active or reauth_required, with account and expiry. */
export const GET = createHandler({}, async ({ request }) => {
  const denied = requireOwner(request);
  if (denied instanceof Error) throw denied;

  const auth = createOpenAIAuth();
  if (auth instanceof Error) throw auth;

  const status = await auth.status();
  if (status instanceof Error) throw status;

  return Response.json(status);
});
