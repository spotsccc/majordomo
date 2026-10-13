import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { zstdDecompressSync } from "node:zlib";
import { test as base, expect, type Page } from "@playwright/test";
import { SESSION_COOKIE, sessionValue } from "@/lib/owner-session";
import { signOut } from "@/lib/chatgpt.test-utils";
import { BASE_URL, FAKE_OPENAI_URL } from "./env";

type Handler = (request: Request) => Response | Promise<Response>;

export interface ReceivedRequest {
  method: string;
  url: string;
  headers: Headers;
  body: string;
}

export interface FakeOpenAI {
  /** A request without a handler gets 500 and fails the test. */
  on(route: string, handler: Handler): void;
  readonly requests: readonly ReceivedRequest[];
}

interface Session {
  handlers: Map<string, Handler>;
  requests: ReceivedRequest[];
  failures: string[];
}

const HOP_BY_HOP = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "transfer-encoding",
]);

export const test = base.extend<
  { openai: FakeOpenAI; cleanState: void; ownerPage: Page },
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
  ownerPage: async ({ page, context }, provide) => {
    await context.addCookies([
      {
        name: SESSION_COOKIE,
        value: sessionValue(),
        url: BASE_URL,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);
    await provide(page);
  },
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
