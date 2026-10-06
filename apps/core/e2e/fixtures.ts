/**
 * Playwright fixtures of the e2e tests: the fake OpenAI that the server talks
 * to (through `fake-openai.ts`) and a ChatGPT state cleaned before every
 * test. Both are automatic, so every test starts the fake with no handlers
 * and fails on a request without one, whether it uses `openai` or not. Tests
 * import `test` and `expect` from here.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { zstdDecompressSync } from "node:zlib";
import { test as base, expect } from "@playwright/test";
import { signOut } from "@/lib/chatgpt.test-utils";
import { FAKE_OPENAI_URL } from "./env";

/** Answers one route of the fake OpenAI. */
type Handler = (request: Request) => Response | Promise<Response>;

/** A request the fake received: the original URL, and the body as text with zstd decompressed. */
export interface ReceivedRequest {
  method: string;
  url: string;
  headers: Headers;
  body: string;
}

/** The fake OpenAI as a test sees it. */
export interface FakeOpenAI {
  /**
   * Answers `"METHOD https://host/path"` (without the query) with `handler`
   * until the test ends. A request without a handler gets 500 and fails the
   * test.
   */
  on(route: string, handler: Handler): void;
  /** Requests of this test in the order they arrived. */
  readonly requests: readonly ReceivedRequest[];
}

/** What the fake knows about the running test; replaced before each test. */
interface Session {
  handlers: Map<string, Handler>;
  requests: ReceivedRequest[];
  failures: string[];
}

/** Headers that belong to the connection to the fake, not to the request. */
const HOP_BY_HOP = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "transfer-encoding",
]);

export const test = base.extend<
  { openai: FakeOpenAI; cleanState: void },
  { fakeOpenAI: { session: Session } }
>({
  fakeOpenAI: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright reads fixture dependencies from this destructuring pattern
    async ({}, provide) => {
      const fake = { session: newSession() };
      const server = createServer((incoming, outgoing) => {
        void serve(fake.session, incoming, outgoing);
      });
      const { hostname, port } = new URL(FAKE_OPENAI_URL);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(Number(port), hostname, resolve);
      });
      await provide(fake);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    { scope: "worker" },
  ],
  openai: [
    async ({ fakeOpenAI }, provide) => {
      const session = newSession();
      fakeOpenAI.session = session;
      await provide({
        on: (route, handler) => {
          session.handlers.set(route, handler);
        },
        requests: session.requests,
      });
      expect(session.failures, "запросы к фейковому OpenAI").toEqual([]);
    },
    { auto: true },
  ],
  cleanState: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright reads fixture dependencies from this destructuring pattern
    async ({}, provide) => {
      await signOut();
      await provide();
    },
    { auto: true },
  ],
});

export { expect };

function newSession(): Session {
  return { handlers: new Map(), requests: [], failures: [] };
}

/**
 * Answers one request of the server: restores the original URL from the
 * path (`/chatgpt.com/x` → `https://chatgpt.com/x`), records the request and
 * streams the handler's response as it is produced, so SSE arrives in parts.
 * Missing handlers and handler errors are answered with 500 and recorded as
 * failures of the test.
 */
async function serve(
  session: Session,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): Promise<void> {
  const url = new URL(`https:/${incoming.url ?? "/"}`);
  const method = incoming.method ?? "GET";
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  session.requests.push({
    method,
    url: url.href,
    headers,
    body:
      headers.get("content-encoding") === "zstd"
        ? zstdDecompressSync(body).toString()
        : body.toString(),
  });

  const route = `${method} ${url.origin}${url.pathname}`;
  const handler = session.handlers.get(route);
  if (!handler) {
    session.failures.push(`нет обработчика для ${route}`);
    outgoing.writeHead(500).end();
    return;
  }
  const response = await Promise.resolve()
    .then(() =>
      handler(
        new Request(url, {
          method,
          headers,
          body: body.length > 0 ? body : undefined,
        }),
      ),
    )
    .catch((error: unknown) => {
      session.failures.push(`${route}: ${String(error)}`);
      return new Response(null, { status: 500 });
    });

  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) {
    const reader = response.body.getReader();
    for (
      let next = await reader.read();
      !next.done;
      next = await reader.read()
    ) {
      outgoing.write(next.value);
    }
  }
  outgoing.end();
}
