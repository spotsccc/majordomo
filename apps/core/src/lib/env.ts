import { HandlerError } from "@repo/handler";
import { createTaggedError } from "@spotsccc/error-as-value";

/** Server configuration. Read lazily, so a missing variable fails the request that needs it, not the build. */
export function requiredEnv(name: string): ConfigurationError | string {
  const value = process.env[name];
  if (!value) {
    return new ConfigurationError({
      message: `Не задана переменная окружения ${name}`,
    });
  }
  return value;
}

/** A configuration mistake: the handler answers 500 with a readable message instead of a stack trace. */
export class ConfigurationError extends createTaggedError({
  name: "ConfigurationError",
  extends: HandlerError,
}) {}

export const DEFAULT_MODEL = "gpt-5.6-luna";
