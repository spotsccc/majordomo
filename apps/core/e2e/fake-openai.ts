/**
 * Preload of the e2e server only (`NODE_OPTIONS=--import`, set in
 * `playwright.config.ts`; app code never imports it). Sends the server's
 * requests to chatgpt.com and auth.openai.com to the fake OpenAI at
 * `E2E_OPENAI_URL`, with the original host as the first path segment
 * (`https://chatgpt.com/x` → `<E2E_OPENAI_URL>/chatgpt.com/x`), and refuses
 * any other request that leaves the machine, so e2e never reaches the real
 * internet.
 *
 * It replaces `fetch` before Next.js starts, so Next wraps this function with
 * its own and app code runs unchanged. OpenAI calls pass a URL string and
 * `init` (`@fieldwork-ai/codex-transport`, `OpenAISubscriptionAuth`); a
 * `Request` object is refused rather than rewritten without its body.
 *
 * Throws on load without `E2E_OPENAI_URL`, so a misconfigured server does not
 * start against the real OpenAI. Runs under Node.js type stripping: erasable
 * syntax and `node:` imports only.
 */
const target = process.env.E2E_OPENAI_URL;
if (!target) throw new Error("fake-openai.ts: E2E_OPENAI_URL не задан");

const OPENAI_HOSTS = new Set(["chatgpt.com", "auth.openai.com"]);
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const realFetch = globalThis.fetch;

globalThis.fetch = async (
  input: string | URL | Request,
  init?: RequestInit,
) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (LOCAL_HOSTS.has(url.hostname)) return realFetch(input, init);
  if (!OPENAI_HOSTS.has(url.hostname) || input instanceof Request) {
    throw new Error(`e2e: запрос ${url.origin} не подменён (fake-openai.ts)`);
  }
  return realFetch(
    new URL(`/${url.hostname}${url.pathname}${url.search}`, target),
    init,
  );
};
