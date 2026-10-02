import { createHandler } from "@repo/handler";
import { requireOwner } from "@/lib/auth";
import { services } from "@/lib/services";

/** Forgets the ChatGPT session and revokes its refresh token. */
export const POST = createHandler({}, async ({ request }) => {
  requireOwner(request);
  const { auth, deviceLogins } = services();
  await deviceLogins.clear();
  await auth.logout();
  return Response.json({ state: "logged_out" });
});
