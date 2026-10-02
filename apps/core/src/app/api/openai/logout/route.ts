import { createHandler } from "@repo/handler";
import { requireOwner } from "@/lib/auth";
import { createDeviceLoginStore, createOpenAIAuth } from "@/lib/openai";

/** Forgets the ChatGPT session and revokes its refresh token. */
export const POST = createHandler({}, async ({ request }) => {
  requireOwner(request);
  await createDeviceLoginStore().clear();
  await createOpenAIAuth().logout();
  return Response.json({ state: "logged_out" });
});
