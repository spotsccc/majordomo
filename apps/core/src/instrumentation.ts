/**
 * Runs once when a server instance starts, before it handles requests. Loading
 * the config here makes a missing or invalid environment variable fail the
 * start instead of the first request that needs it. Only the Node.js runtime:
 * the config pulls in `node:crypto` through `@repo/db`.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./lib/config");
  }
}
