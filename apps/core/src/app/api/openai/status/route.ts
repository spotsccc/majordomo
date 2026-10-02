import { createHandler } from "@repo/handler";
import { requireOwner } from "@/lib/auth";
import { services } from "@/lib/services";

/** Session state: logged_out, active or reauth_required, with account and expiry. */
export const GET = createHandler({}, async ({ request }) => {
  requireOwner(request);
  return Response.json(await services().auth.status());
});
