import { createHandler } from "@repo/handler";
import { requireOwner } from "@/lib/auth";
import { createDeviceLoginStore, createOpenAIAuth } from "@/lib/openai";

/** Forgets the ChatGPT session and revokes its refresh token. */
export const POST = createHandler({ guards: [requireOwner] }, async () => {
  const cleared = await createDeviceLoginStore().clear();
  if (cleared instanceof Error) throw cleared;

  const loggedOut = await createOpenAIAuth().logout();
  if (loggedOut instanceof Error) throw loggedOut;

  return Response.json({ state: "logged_out" });
});
