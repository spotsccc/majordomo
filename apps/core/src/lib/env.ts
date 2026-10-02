import { HandlerError } from "@repo/handler";

/** Server configuration. Read lazily, so a missing variable fails the request that needs it, not the build. */
export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new ConfigurationError(`Не задана переменная окружения ${name}`);
  return value;
}

/** A configuration mistake: the handler answers 500 with a readable message instead of a stack trace. */
export class ConfigurationError extends HandlerError {
  constructor(message: string) {
    super(500, message);
  }
}

export const DEFAULT_MODEL = "gpt-5.6-luna";
