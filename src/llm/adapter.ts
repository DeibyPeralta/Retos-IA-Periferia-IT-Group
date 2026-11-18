export type ToolCall = { name: string; args: Record<string, unknown> };
export type ToolDefinition = { name: string; description: string; parameters: Record<string, unknown> };
export type LlmTurn = { type: "text"; text: string } | { type: "tool_calls"; calls: ToolCall[] };

export interface LlmAdapter {
  enviar(mensajes: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>, herramientas: ToolDefinition[]): Promise<LlmTurn>;
}
