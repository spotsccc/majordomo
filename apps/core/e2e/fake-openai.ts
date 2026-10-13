/**
 * Throws on load without `E2E_OPENAI_URL`, so a misconfigured server never reaches the real
 * OpenAI. Runs under Node.js type stripping: erasable syntax and `node:` imports only.
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
