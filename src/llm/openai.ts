import type { LlmAdapter, LlmTurn, ToolDefinition } from "./adapter.js";

export class OpenAiAdapter implements LlmAdapter {
  constructor(private apiKey: string, private model: string, private baseUrl: string) {}

  async enviar(mensajes: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>, herramientas: ToolDefinition[]): Promise<LlmTurn> {
    if (!this.apiKey) throw new Error("OPENAI_API_KEY no está configurada.");
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: mensajes,
        tools: herramientas.map((tool) => ({
          type: "function",
          function: { name: tool.name, description: tool.description, parameters: tool.parameters }
        }))
      }),
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`Proveedor LLM respondió ${response.status}.`);
    const body = await response.json() as {
      choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ function: { name: string; arguments: string } }> } }>;
    };
    const message = body.choices?.[0]?.message;
    if (message?.tool_calls?.length) {
      return { type: "tool_calls", calls: message.tool_calls.map((call) => ({ name: call.function.name, args: JSON.parse(call.function.arguments) as Record<string, unknown> })) };
    }
    return { type: "text", text: message?.content ?? "No recibí una respuesta del proveedor." };
  }
}
