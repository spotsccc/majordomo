import { integer, jsonb, pgSchema, text, timestamp } from "drizzle-orm/pg-core";

/** Credentials of external services the assistant acts with. Secrets are sealed with SecretBox. */
export const auth = pgSchema("auth");

/** One row per ChatGPT subscription session (`default` for the owner's). */
export const openaiCredentials = auth.table("openai_credentials", {
  id: text("id").primaryKey(),
  /** Bumped on every refresh, login and logout; guards against lost updates. */
  generation: integer("generation").notNull().default(0),
  /** Sealed `OpenAISubscriptionCredential`; null after logout. */
  credential: text("credential"),
  refreshedAt: timestamp("refreshed_at", { withTimezone: true }),
  /** Set when the session died and the owner has to log in again. */
  reauth: jsonb("reauth").$type<{
    reason: string;
    code?: string;
    at: number;
  }>(),
  /** Which process is refreshing the token right now, and until when. */
  leaseId: text("lease_id"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** A started device-code login waiting for the owner to enter the code. */
export const openaiDeviceLogins = auth.table("openai_device_logins", {
  id: text("id").primaryKey(),
  /** Sealed `PendingDeviceLogin`: whoever holds it can collect the tokens. */
  pending: text("pending").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
