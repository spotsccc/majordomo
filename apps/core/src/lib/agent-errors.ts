import { z } from "zod";

export const AgentErrorCode = z.enum(["openai_login_required", "model_failed"]);
export type AgentErrorCode = z.infer<typeof AgentErrorCode>;
