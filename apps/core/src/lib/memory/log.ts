/**
 * Only the message of `error` and the names and codes of its causes: Drizzle puts the query
 * parameters, the owner's memory and messages, into the message of its error, and the AI SDK puts
 * the model's answer into its own (E17).
 */
export function logFailure(label: string, error: Error): void {
  const causes: string[] = [];
  for (
    let cause: unknown = error.cause;
    cause instanceof Error;
    cause = cause.cause
  ) {
    causes.push(
      "code" in cause && typeof cause.code === "string"
        ? `${cause.name} ${cause.code}`
        : cause.name,
    );
  }
  console.error(label, error.message, causes.join(" ← "));
}
