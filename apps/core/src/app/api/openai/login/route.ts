import { createHandler } from "@repo/handler";
import { DeviceLoginUnavailableError } from "@repo/openai-subscription";
import { requireOwner } from "@/lib/auth";
import { checkDeviceLogin, ensureDeviceLogin } from "@/lib/openai-login";
import { services } from "@/lib/services";

/** Starts a device login (or returns the one in progress): a link and a code for the owner. */
export const POST = createHandler({}, async ({ request }) => {
  requireOwner(request);
  try {
    return Response.json(await ensureDeviceLogin(services()));
  } catch (error) {
    if (!(error instanceof DeviceLoginUnavailableError)) throw error;
    return Response.json(
      { error: "device_login_unavailable", message: error.message },
      { status: 409 },
    );
  }
});

/** Polled by the client while the code is on screen: pending, complete or none. */
export const GET = createHandler({}, async ({ request }) => {
  requireOwner(request);
  return Response.json(await checkDeviceLogin(services()));
});
