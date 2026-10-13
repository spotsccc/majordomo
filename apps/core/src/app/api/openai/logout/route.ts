import { createHandler } from "@repo/handler";
import { requireOwner } from "@/lib/auth";
import { createOpenAIAuth } from "@/lib/openai";
import { clearDeviceLogin } from "@/lib/openai-store";

export const POST = createHandler({ guards: [requireOwner] }, async () => {
  const cleared = await clearDeviceLogin();
  if (cleared instanceof Error) throw cleared;

  const loggedOut = await createOpenAIAuth().logout();
  if (loggedOut instanceof Error) throw loggedOut;

  return Response.json({ state: "logged_out" });
});
