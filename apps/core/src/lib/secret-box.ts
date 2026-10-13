import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { tryFn } from "@spotsccc/error-as-value";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Keys come from the environment, never the database, so a leaked dump or a copied Neon branch
 * is useless without them. To rotate, put the new key first, re-save the secrets, then drop the
 * old one.
 */
export class SecretBox {
  private readonly keys: { id: string; key: Buffer }[];

  private constructor(keys: { id: string; key: Buffer }[]) {
    this.keys = keys;
  }

  static fromKeys(encodedKeys: readonly string[]): Error | SecretBox {
    if (encodedKeys.length === 0) {
      return new Error("SecretBox needs at least one key");
    }
    const keys = encodedKeys.map((encoded) => Buffer.from(encoded, "base64"));
    if (keys.some((key) => key.length !== 32)) {
      return new Error("Encryption key must be 32 bytes, base64-encoded");
    }
    return new SecretBox(keys.map((key) => ({ id: keyId(key), key })));
  }

  seal(plaintext: string, aad = ""): string {
    const { id, key } = this.keys[0]!;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const payload = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    return `${VERSION}.${id}.${payload.toString("base64url")}`;
  }

  open(sealed: string, aad = ""): Error | string {
    const [version, id, encoded] = sealed.split(".");
    if (version !== VERSION || !id || !encoded) {
      return new Error("Unknown sealed secret format");
    }
    const entry = this.keys.find((candidate) => candidate.id === id);
    if (!entry) return new Error(`No decryption key with id ${id}`);
    const payload = Buffer.from(encoded, "base64url");
    return tryFn(
      () => {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          entry.key,
          payload.subarray(0, IV_BYTES),
        );
        decipher.setAAD(Buffer.from(aad));
        decipher.setAuthTag(payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
        return Buffer.concat([
          decipher.update(payload.subarray(IV_BYTES + TAG_BYTES)),
          decipher.final(),
        ]).toString("utf8");
      },
      (cause) => new Error("Failed to decrypt secret", { cause }),
    );
  }

  sealJson(value: unknown, aad?: string): string {
    return this.seal(JSON.stringify(value), aad);
  }

  openJson<T>(sealed: string, aad?: string): Error | T {
    const plaintext = this.open(sealed, aad);
    if (plaintext instanceof Error) return plaintext;

    return tryFn(
      () => JSON.parse(plaintext) as T,
      (cause) => new Error("Decrypted secret is not JSON", { cause }),
    );
  }
}

function keyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}
