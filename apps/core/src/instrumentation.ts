/**
 * Loading the config here makes a missing variable fail the start, not the first request.
 * Node.js runtime only: the config pulls in `node:crypto`.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./lib/config");
  }
}
