import { NextResponse, type NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { unstableRethrowMock } = vi.hoisted(() => ({
  unstableRethrowMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  unstable_rethrow: unstableRethrowMock,
}));

import { NotFoundError, ValidationError } from "@repo/errors";
import {
  createHandler,
  ForbiddenError,
  getHandlerRequestContext,
  HandlerError,
  UnauthenticatedError,
} from "../src/index.ts";

describe("createHandler", () => {
  const request = new Request(
    "http://localhost/api/private/articles",
  ) as NextRequest;
  const routeContext = {
    params: Promise.resolve({}),
  };

  beforeEach(() => {
    unstableRethrowMock.mockReset();
  });

  it("returns response from handler", async () => {
    const handler = createHandler({}, async () =>
      NextResponse.json({ ok: true }),
    );
    const response = await handler(request, routeContext);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toMatch(/[0-9a-f-]{36}/);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(unstableRethrowMock).not.toHaveBeenCalled();
  });

  it("accepts x-request-id, returns it and passes it into handler context", async () => {
    const requestWithId = new Request("http://localhost/api/private/articles", {
      headers: { "x-request-id": "req-test-1" },
    }) as NextRequest;
    const handler = createHandler({}, async ({ requestId }) =>
      NextResponse.json({ requestId }),
    );

    const response = await handler(requestWithId, routeContext);

    expect(response.headers.get("x-request-id")).toBe("req-test-1");
    await expect(response.json()).resolves.toEqual({ requestId: "req-test-1" });
  });

  it("exposes request id to services through request context", async () => {
    const requestWithId = new Request("http://localhost/api/private/articles", {
      headers: { "x-request-id": "req-context-1" },
    }) as NextRequest;
    const handler = createHandler({}, async () =>
      NextResponse.json({ requestId: getHandlerRequestContext()?.requestId }),
    );

    const response = await handler(requestWithId, routeContext);

    await expect(response.json()).resolves.toEqual({
      requestId: "req-context-1",
    });
    expect(getHandlerRequestContext()).toBeUndefined();
  });

  it("returns 400 for ValidationError", async () => {
    const handler = createHandler({}, async () => {
      throw new ValidationError("Некорректные данные");
    });
    const response = await handler(request, routeContext);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Некорректные данные",
    });
    expect(unstableRethrowMock).toHaveBeenCalledTimes(1);
  });

  it("returns 404 for NotFoundError", async () => {
    const handler = createHandler({}, async () => {
      throw new NotFoundError("Статья", "article-1");
    });
    const response = await handler(request, routeContext);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Статья не найден: article-1",
    });
  });

  it("returns status from typed auth error", async () => {
    const handler = createHandler({}, async () => {
      throw new UnauthenticatedError();
    });
    const response = await handler(request, routeContext);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Требуется аутентификация",
    });
  });

  it("returns 403 for ForbiddenError", async () => {
    const handler = createHandler({}, async () => {
      throw new ForbiddenError();
    });
    const response = await handler(request, routeContext);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Недостаточно прав",
    });
  });

  it("returns error details for HandlerError", async () => {
    const handler = createHandler({}, async () => {
      throw new HandlerError(400, "Некорректный запрос", { field: "query" });
    });
    const response = await handler(request, routeContext);

    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toMatch(/[0-9a-f-]{36}/);
    await expect(response.json()).resolves.toEqual({
      error: "Некорректный запрос",
      details: { field: "query" },
    });
  });

  it("logs unexpected errors without returning raw message text", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const handler = createHandler({}, async () => {
      throw new Error("user message text must not be returned");
    });

    try {
      const response = await handler(request, routeContext);

      expect(response.status).toBe(500);
      expect(response.headers.get("x-request-id")).toMatch(/[0-9a-f-]{36}/);
      await expect(response.json()).resolves.toEqual({
        error: "Внутренняя ошибка сервера",
      });
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[handler]",
        expect.objectContaining({
          event: "route_handler_unexpected_error",
          error_class: "Error",
          error: expect.any(Error),
        }),
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("passes validated params, query and body into handler context", async () => {
    const requestWithBody = new Request(
      "http://localhost/api/private/articles/article-1?page=2",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "Rome guide",
        }),
      },
    ) as NextRequest;
    const handler = createHandler(
      {
        params: z.object({
          id: z.string(),
        }),
        query: z.object({
          page: z.coerce.number().int(),
        }),
        body: z.object({
          title: z.string(),
        }),
      },
      async ({ params, query, body, signal }) =>
        NextResponse.json({
          id: params.id,
          page: query.page,
          title: body.title,
          sameSignal: signal === requestWithBody.signal,
        }),
    );

    const response = await handler(requestWithBody, {
      params: Promise.resolve({
        id: "article-1",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: "article-1",
      page: 2,
      title: "Rome guide",
      sameSignal: true,
    });
  });
});
