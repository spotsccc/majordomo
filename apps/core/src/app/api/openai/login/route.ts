import { createHandler } from "@repo/handler";
import { DeviceLoginUnavailableError } from "@repo/openai-subscription";
import { requireOwner } from "@/lib/auth";
import { checkDeviceLogin, ensureDeviceLogin } from "@/lib/openai-login";

/** Starts a device login (or returns the one in progress): a link and a code for the owner. */
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

/** Polled by the client while the code is on screen: pending, complete or none. */
export const GET = createHandler({ guards: [requireOwner] }, async () => {
  const progress = await checkDeviceLogin();
  if (progress instanceof Error) throw progress;

  return Response.json(progress);
});
