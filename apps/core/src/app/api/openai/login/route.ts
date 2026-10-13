import { createHandler } from "@repo/handler";
import { DeviceLoginUnavailableError } from "@repo/openai-subscription";
import { requireOwner } from "@/lib/auth";
import { checkDeviceLogin, ensureDeviceLogin } from "@/lib/openai-login";

export const POST = createHandler({ guards: [requireOwner] }, async () => {
  const login = await ensureDeviceLogin();
  if (login instanceof DeviceLoginUnavailableError) {
    return Response.json(
      { error: "device_login_unavailable", message: login.message },
      { status: 409 },
    );
  }
  if (login instanceof Error) throw login;

  return Response.json(login);
});

export const GET = createHandler({ guards: [requireOwner] }, async () => {
  const progress = await checkDeviceLogin();
  if (progress instanceof Error) throw progress;

  return Response.json(progress);
});
