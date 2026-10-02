import { createHandler } from "@repo/handler";
import { requireOwner } from "@/lib/auth";
import { createDeviceLoginStore, createOpenAIAuth } from "@/lib/openai";

/** Forgets the ChatGPT session and revokes its refresh token. */
export const POST = createHandler({}, async ({ request }) => {
  const denied = requireOwner(request);
  if (denied instanceof Error) throw denied;

  const deviceLogins = createDeviceLoginStore();
  if (deviceLogins instanceof Error) throw deviceLogins;

  const cleared = await deviceLogins.clear();
  if (cleared instanceof Error) throw cleared;

  const auth = createOpenAIAuth();
  if (auth instanceof Error) throw auth;

  const loggedOut = await auth.logout();
  if (loggedOut instanceof Error) throw loggedOut;

  return Response.json({ state: "logged_out" });
});
