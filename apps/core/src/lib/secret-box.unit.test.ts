import { randomBytes } from "node:crypto";
import { unwrap } from "@spotsccc/error-as-value";
import { describe, expect, it } from "vitest";
import { SecretBox } from "./secret-box";

describe("SecretBox", () => {
  it("decrypts with a rotated-out key and binds the ciphertext to its place", () => {
    const oldKey = randomBytes(32).toString("base64");
    const sealed = unwrap(SecretBox.fromKeys([oldKey])).seal("secret", "row:1");
    const rotated = unwrap(
      SecretBox.fromKeys([randomBytes(32).toString("base64"), oldKey]),
    );

    expect(rotated.open(sealed, "row:1")).toBe("secret");
    expect(rotated.open(sealed, "row:2")).toBeInstanceOf(Error);
  });
});
