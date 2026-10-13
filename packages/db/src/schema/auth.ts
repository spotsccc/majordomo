import { integer, jsonb, pgSchema, text, timestamp } from "drizzle-orm/pg-core";

export const auth = pgSchema("auth");

export const openaiCredentials = auth.table("openai_credentials", {
  id: text("id").primaryKey(),
  generation: integer("generation").notNull().default(0),
  /** Sealed with `SecretBox`. */
  credential: text("credential"),
  refreshedAt: timestamp("refreshed_at", { withTimezone: true }),
  reauth: jsonb("reauth").$type<{
    reason: string;
    code?: string;
    at: number;
  }>(),
  leaseId: text("lease_id"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const openaiDeviceLogins = auth.table("openai_device_logins", {
  id: text("id").primaryKey(),
  /** Sealed: whoever holds the `PendingDeviceLogin` can collect the tokens. */
  pending: text("pending").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
