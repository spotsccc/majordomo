import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { AgentErrorCode } from "@/lib/agent-errors";
import { Chat } from "./chat";

const ACTIVE = {
  state: "active",
  email: "owner@example.com",
  planType: "pro",
};

const LOGIN_PROMPT = {
  verificationUrl: "https://auth.openai.com/codex/device",
  userCode: "ABCD-1234",
  expiresAt: "2099-01-01T12:00:00.000Z",
  pollIntervalMs: 10,
};

type Route = (request: Request) => Response | Promise<Response>;

let unexpected: string[] = [];

function stubApi(routes: Record<string, Route>): Request[] {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(
        new URL(input instanceof Request ? input.url : input, location.origin),
        init,
      );
      requests.push(request);
      const key = `${request.method} ${new URL(request.url).pathname}`;
      const route = routes[key];
      if (route) return route(request);
      unexpected.push(key);
      return new Response(null, { status: 501 });
    },
  );
  return requests;
}

function sequence(first: Route, ...rest: Route[]): Route {
  const routes = [first, ...rest];
  let calls = 0;
  return (request) =>
    (routes[Math.min(calls++, rest.length)] ?? first)(request);
}

function answer(text: string): Route {
  return () =>
    createUIMessageStreamResponse({
      stream: createUIMessageStream({
        execute({ writer }) {
          writer.write({ type: "text-start", id: "t1" });
          writer.write({ type: "text-delta", id: "t1", delta: text });
          writer.write({ type: "text-end", id: "t1" });
        },
      }),
    });
}

function failure(code: AgentErrorCode): Route {
  return () =>
    createUIMessageStreamResponse({
      stream: createUIMessageStream({
        execute({ writer }) {
          writer.write({ type: "error", errorText: code });
        },
      }),
    });
}

function json(body: unknown, status = 200): Route {
  return () => Response.json(body, { status });
}

function requestsTo(requests: Request[], path: string): Request[] {
  return requests.filter((request) => new URL(request.url).pathname === path);
}

describe("Chat", () => {
  /**
   * The pointer stays where the previous test left it; moved to the corner,
   * it cannot hover an element and change a screenshot.
   */
  beforeEach(async () => {
    unexpected = [];
    await page
      .elementLocator(document.documentElement)
      .hover({ position: { x: 0, y: 0 } });
  });

  afterEach(() => {
    expect(unexpected).toEqual([]);
  });

  it("shows the status of a tool while it runs and after it", async () => {
    let finishTool = () => {};
    const toolDone = new Promise<void>((resolve) => {
      finishTool = resolve;
    });
    stubApi({
      "GET /api/openai/status": json(ACTIVE),
      "POST /api/agent": () =>
        createUIMessageStreamResponse({
          stream: createUIMessageStream({
            async execute({ writer }) {
              writer.write({
                type: "tool-input-available",
                toolCallId: "call_1",
                toolName: "create_transaction",
                input: {},
              });
              await toolDone;
              writer.write({
                type: "tool-output-available",
                toolCallId: "call_1",
                output: { transaction: {}, balances: [] },
              });
              writer.write({
                type: "tool-input-available",
                toolCallId: "call_2",
                toolName: "delete_transaction",
                input: {},
              });
              writer.write({
                type: "tool-output-available",
                toolCallId: "call_2",
                output: { error: { code: "not_found", message: "Не найдено" } },
              });
              writer.write({ type: "text-start", id: "t1" });
              writer.write({
                type: "text-delta",
                id: "t1",
                delta: "Записал: 3 500 ARS.",
              });
              writer.write({ type: "text-end", id: "t1" });
            },
          }),
        }),
    });
    const screen = await render(<Chat />);

    await screen
      .getByPlaceholder("Сообщение")
      .fill("потратил 3500 песо на кофе");
    await screen.getByRole("button", { name: "Отправить" }).click();

    await expect.element(screen.getByText("Записываю…")).toBeVisible();
    finishTool();
    await expect.element(screen.getByText("Записано")).toBeVisible();
    await expect.element(screen.getByText("Не получилось")).toBeVisible();
    await expect.element(screen.getByText("Записал: 3 500 ARS.")).toBeVisible();
    await expect(screen.getByRole("main")).toMatchScreenshot("tool-status");
  });

  it("shows the conversation with the streamed answer", async () => {
    const requests = stubApi({
      "GET /api/openai/status": json(ACTIVE),
      "POST /api/agent": answer("pong"),
    });
    const screen = await render(<Chat />);

    await screen.getByPlaceholder("Сообщение").fill("ping");
    await screen.getByRole("button", { name: "Отправить" }).click();

    await expect.element(screen.getByText("pong")).toBeVisible();
    await expect.element(screen.getByText("ping")).toBeVisible();
    await expect(screen.getByRole("main")).toMatchScreenshot("conversation");
    expect(requestsTo(requests, "/api/agent")).toHaveLength(1);
  });

  it("sends the owner to the login page when the session is no longer valid (E11)", async () => {
    stubApi({
      "GET /api/openai/status": json(ACTIVE),
      "POST /api/agent": json({ error: "Требуется аутентификация" }, 401),
    });
    const screen = await render(<Chat />);

    await screen.getByPlaceholder("Сообщение").fill("ping");
    await screen.getByRole("button", { name: "Отправить" }).click();

    const notice = screen.getByText(/^Вход устарел\. Войдите заново\./);
    await expect.element(notice).toBeVisible();
    await expect
      .element(notice.getByRole("link", { name: "Войти" }))
      .toHaveAttribute("href", "/login");
  });

  it("logs in to Codex with a device code and resends the turn that needed it", async () => {
    let approved = false;
    stubApi({
      "GET /api/openai/status": sequence(json({ state: "logged_out" }), () =>
        Response.json(approved ? ACTIVE : { state: "logged_out" }),
      ),
      "POST /api/agent": sequence(
        failure("openai_login_required"),
        answer("pong"),
      ),
      "POST /api/openai/login": json(LOGIN_PROMPT),
      "GET /api/openai/login": () =>
        Response.json({ state: approved ? "complete" : "pending" }),
    });
    const screen = await render(<Chat />);

    await screen.getByPlaceholder("Сообщение").fill("ping");
    await screen.getByRole("button", { name: "Отправить" }).click();
    await expect.element(screen.getByText("ABCD-1234")).toBeVisible();
    await expect(screen.getByRole("main")).toMatchScreenshot("device-code");
    approved = true;

    await expect.element(screen.getByText("pong")).toBeVisible();
    await expect.element(screen.getByText("ABCD-1234")).not.toBeInTheDocument();
    await expect
      .element(screen.getByText("Codex: owner@example.com (pro)"))
      .toBeVisible();
  });

  it("shows why the login did not finish and starts a new one on request", async () => {
    const requests = stubApi({
      "GET /api/openai/status": json({ state: "logged_out" }),
      "POST /api/openai/login": json(LOGIN_PROMPT),
      "GET /api/openai/login": sequence(
        json({ state: "none" }),
        json({ state: "failed", message: "Код отклонён" }),
      ),
    });
    const screen = await render(<Chat />);

    await screen.getByRole("button", { name: "Войти в Codex" }).click();
    await expect.element(screen.getByText("Вход не завершён.")).toBeVisible();
    await screen.getByRole("button", { name: "Получить новый код" }).click();

    await expect.element(screen.getByText("Код отклонён")).toBeVisible();
    expect(requestsTo(requests, "/api/openai/login")).toHaveLength(4);
  });

  it("keeps the code on screen and keeps polling when a check fails", async () => {
    let approved = false;
    stubApi({
      "GET /api/openai/status": () =>
        Response.json(approved ? ACTIVE : { state: "logged_out" }),
      "POST /api/openai/login": json(LOGIN_PROMPT),
      "GET /api/openai/login": sequence(json({ error: "boom" }, 500), () =>
        Response.json({ state: approved ? "complete" : "pending" }),
      ),
    });
    const screen = await render(<Chat />);

    await screen.getByRole("button", { name: "Войти в Codex" }).click();
    await expect.element(screen.getByText("boom")).toBeVisible();
    await expect.element(screen.getByText("ABCD-1234")).toBeVisible();
    approved = true;

    await expect
      .element(screen.getByText("Codex: owner@example.com (pro)"))
      .toBeVisible();
    await expect.element(screen.getByText("ABCD-1234")).not.toBeInTheDocument();
  });

  it("reports an expired code without asking the server", async () => {
    stubApi({
      "GET /api/openai/status": json({ state: "logged_out" }),
      "POST /api/openai/login": json({
        ...LOGIN_PROMPT,
        expiresAt: "2000-01-01T00:00:00.000Z",
      }),
    });
    const screen = await render(<Chat />);

    await screen.getByRole("button", { name: "Войти в Codex" }).click();

    await expect.element(screen.getByText("Код истёк.")).toBeVisible();
  });

  it("explains how to log in on the server when device login is unavailable", async () => {
    stubApi({
      "GET /api/openai/status": json({ state: "logged_out" }),
      "POST /api/openai/login": json(
        {
          error: "device_login_unavailable",
          message: "Вход по коду выключен",
        },
        409,
      ),
    });
    const screen = await render(<Chat />);

    await screen.getByRole("button", { name: "Войти в Codex" }).click();

    await expect
      .element(screen.getByText("Вход по коду выключен"))
      .toBeVisible();
    await expect
      .element(
        screen.getByText(
          "node packages/openai-subscription/dist/cli.js login --browser",
        ),
      )
      .toBeVisible();
  });

  it("shows a request the server refused without offering a retry", async () => {
    stubApi({
      "GET /api/openai/status": json(ACTIVE),
      "POST /api/agent": json({ error: "Слишком большой запрос" }, 422),
    });
    const screen = await render(<Chat />);

    await screen.getByPlaceholder("Сообщение").fill("ping");
    await screen.getByRole("button", { name: "Отправить" }).click();

    await expect
      .element(screen.getByText(/^Сервер не принял запрос \(422\)\./))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Повторить" }))
      .not.toBeInTheDocument();
  });

  it("offers a retry after a model failure", async () => {
    stubApi({
      "GET /api/openai/status": json(ACTIVE),
      "POST /api/agent": sequence(failure("model_failed"), answer("pong")),
    });
    const screen = await render(<Chat />);

    await screen.getByPlaceholder("Сообщение").fill("ping");
    await screen.getByRole("button", { name: "Отправить" }).click();
    await expect
      .element(
        screen.getByText(
          /^Не получилось получить ответ\. Попробуйте ещё раз\./,
        ),
      )
      .toBeVisible();
    await screen.getByRole("button", { name: "Повторить" }).click();

    await expect.element(screen.getByText("pong")).toBeVisible();
  });

  it("logs out of Codex", async () => {
    stubApi({
      "GET /api/openai/status": sequence(
        json(ACTIVE),
        json({ state: "logged_out" }),
      ),
      "POST /api/openai/logout": json({ state: "logged_out" }),
    });
    const screen = await render(<Chat />);

    await screen.getByRole("button", { name: "Выйти из Codex" }).click();

    await expect
      .element(screen.getByText("Codex: вход не выполнен"))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Войти в Codex" }))
      .toBeVisible();
  });
});
