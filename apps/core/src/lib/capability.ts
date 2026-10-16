import type { ToolSet } from "ai";

/**
 * `messageId` is a row of `chat.messages`, not a `UIMessage` id. The web chat stores no messages,
 * so it has no turn and no source for a memory write (П1).
 */
export type Turn = { conversationId: string; messageId: string };

/**
 * Tool descriptions and schemas reach the model apart from the system prompt, so `rules` holds
 * only the rules that tie several tools together.
 */
export type Capability = {
  name: string;
  rules: string[];
  tools: (turn: Turn | undefined) => ToolSet;
};
