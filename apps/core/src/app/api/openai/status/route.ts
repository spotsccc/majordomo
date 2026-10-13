import { createHandler } from "@repo/handler";
import { requireOwner } from "@/lib/auth";
import { createOpenAIAuth } from "@/lib/openai";

export const GET = createHandler({ guards: [requireOwner] }, async () => {
  const status = await createOpenAIAuth().status();
  if (status instanceof Error) throw status;

  return Response.json(status);
});
