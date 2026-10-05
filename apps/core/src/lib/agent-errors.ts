import { z } from "zod";

/**
 * Codes that `/api/agent` sends as the `errorText` of the UI stream error
 * chunk; `toClientError` parses them back on the client. Only the code
 * crosses the wire, error messages stay on the server.
 */
export const AgentErrorCode = z.enum(["openai_login_required", "model_failed"]);
export type AgentErrorCode = z.infer<typeof AgentErrorCode>;
