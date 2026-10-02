import { NextResponse, type NextRequest } from "next/server";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { createHandler, validateRequest } from "../src/index.ts";

describe("validateRequest", () => {
  it("parses query params with correct runtime values and types", async () => {
    const request = new Request(
      "http://localhost/api/private/articles?page=2&limit=15&status=draft",
    ) as NextRequest;

    const { query } = await validateRequest(request, {
      query: z.object({
        page: z.coerce.number().int(),
        limit: z.coerce.number().int(),
        status: z.enum(["draft", "published"]).optional(),
      }),
    });

    expect(query).toEqual({
      page: 2,
      limit: 15,
      status: "draft",
    });
    expectTypeOf(query.page).toEqualTypeOf<number>();
    expectTypeOf(query.limit).toEqualTypeOf<number>();
    expectTypeOf(query.status).toEqualTypeOf<
      "draft" | "published" | undefined
    >();
  });

  it("parses route params with correct runtime values and types", async () => {
    const request = new Request(
      "http://localhost/api/private/articles/article-1",
    ) as NextRequest;

    const { params } = await validateRequest(
      request,
      {
        params: z.object({
          id: z.string(),
        }),
      },
      {
        params: Promise.resolve({
          id: "article-1",
        }),
      },
    );

    expect(params).toEqual({
      id: "article-1",
    });
    expectTypeOf(params.id).toEqualTypeOf<string>();
  });

  it("supports repeated query params as arrays", async () => {
    const request = new Request(
      "http://localhost/api/private/articles?tag=sea&tag=city",
    ) as NextRequest;

    const { query } = await validateRequest(request, {
      query: z.object({
        tag: z.array(z.string()),
      }),
    });

    expect(query.tag).toEqual(["sea", "city"]);
  });

  it("parses json body with correct runtime values and types", async () => {
    const request = new Request("http://localhost/api/private/articles", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Rome guide",
        published: true,
      }),
    }) as NextRequest;

    const { body } = await validateRequest(request, {
      body: z.object({
        title: z.string(),
        published: z.boolean(),
      }),
    });

    expect(body).toEqual({
      title: "Rome guide",
      published: true,
    });
    expectTypeOf(body.title).toEqualTypeOf<string>();
    expectTypeOf(body.published).toEqualTypeOf<boolean>();
  });

  it("returns 400 with zod issues for invalid query params", async () => {
    const handler = createHandler(
      {
        query: z.object({
          page: z.coerce.number().int().min(1),
        }),
      },
      async () => NextResponse.json({ ok: true }),
    );

    const response = await handler(
      new Request(
        "http://localhost/api/private/articles?page=0",
      ) as NextRequest,
      {
        params: Promise.resolve({}),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Ошибка валидации query параметров",
      details: [
        expect.objectContaining({
          path: ["page"],
        }),
      ],
    });
  });

  it("returns 400 for invalid json body", async () => {
    const handler = createHandler(
      {
        body: z.object({
          title: z.string(),
        }),
      },
      async () => NextResponse.json({ ok: true }),
    );

    const response = await handler(
      new Request("http://localhost/api/private/articles", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: '{"title":',
      }) as NextRequest,
      {
        params: Promise.resolve({}),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Некорректное JSON тело запроса",
    });
  });
});
