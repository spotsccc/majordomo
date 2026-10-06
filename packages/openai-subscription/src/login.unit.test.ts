import { describe, expect, it } from "vitest";
import { normalizeCallbackUrl } from "./login.js";

describe("normalizeCallbackUrl", () => {
  it("turns a pasted callback URL, query or bare parameters into the redirect URL", () => {
    const redirect = "http://localhost:1455/auth/callback";
    expect(
      normalizeCallbackUrl(
        " http://localhost:1455/auth/callback?code=1 ",
        redirect,
      ),
    ).toBe(`${redirect}?code=1`);
    expect(normalizeCallbackUrl("code=1&state=2", redirect)).toBe(
      `${redirect}?code=1&state=2`,
    );
    expect(normalizeCallbackUrl("?code=1", redirect)).toBe(
      `${redirect}?code=1`,
    );
  });
});
