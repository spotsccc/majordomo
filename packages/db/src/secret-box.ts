import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Encrypts secrets (OAuth tokens, integration keys) before they reach the
 * database, with AES-256-GCM.
 *
 * Keys come from the environment, never from the database, so a leaked dump or
 * a Neon branch copied for a preview deployment is useless without them. The
 * first key encrypts; all keys decrypt, which allows rotation: put the new key
 * first, re-save the secrets, then drop the old one.
 *
 * Sealed format: `v1.<key id>.<base64url(iv | tag | ciphertext)>`.
 */
export class SecretBox {
  private readonly keys: { id: string; key: Buffer }[];

  constructor(keys: readonly string[]) {
    if (keys.length === 0) throw new Error("SecretBox needs at least one key");
    this.keys = keys.map((encoded) => {
      const key = Buffer.from(encoded, "base64");
      if (key.length !== 32) {
        throw new Error("Encryption key must be 32 bytes, base64-encoded");
      }
      return { id: keyId(key), key };
    });
  }

  /** Reads comma-separated keys from `SECRETS_ENCRYPTION_KEYS`. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): SecretBox {
    const value = env.SECRETS_ENCRYPTION_KEYS;
    if (!value) {
      throw new Error(
        "SECRETS_ENCRYPTION_KEYS is not set. Generate a key: openssl rand -base64 32",
      );
    }
    return new SecretBox(value.split(",").map((key) => key.trim()));
  }

  /** `aad` binds the ciphertext to its place, e.g. a table and row id. */
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

  open(sealed: string, aad = ""): string {
    const [version, id, encoded] = sealed.split(".");
    if (version !== VERSION || !id || !encoded) {
      throw new Error("Unknown sealed secret format");
    }
    const entry = this.keys.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`No decryption key with id ${id}`);
    const payload = Buffer.from(encoded, "base64url");
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
  }

  sealJson(value: unknown, aad?: string): string {
    return this.seal(JSON.stringify(value), aad);
  }

  openJson<T>(sealed: string, aad?: string): T {
    return JSON.parse(this.open(sealed, aad)) as T;
  }
}

function keyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}
