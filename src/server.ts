import express from "express";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { z } from "zod";
import * as oc from "./tools/oc.js";
import { OpenAiAdapter } from "./llm/openai.js";
import type { LlmAdapter, ToolDefinition } from "./llm/adapter.js";

const directory = resolve(".");
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(join(directory, "web")));

const sessions = new Map<string, Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>>();
const confirmations = new Map<string, boolean>();
const systemPrompt = await readFile(join(directory, "agent/prompt.md"), "utf8");

const apiKey = process.env.OPENAI_API_KEY ?? "";
const llm: LlmAdapter = new OpenAiAdapter(apiKey, process.env.OPENAI_MODEL ?? "gpt-4o-mini", process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1");

type OcTool = { description: string; args: z.ZodRawShape; execute(args: never, ctx: { directory: string; sessionId: string }): Promise<string> };
const tools: Record<string, OcTool> = {
  oc_leer_paquete: oc.leer_paquete as unknown as OcTool,
  oc_validar: oc.validar as unknown as OcTool,
  oc_construir_payload: oc.construir_payload as unknown as OcTool,
  oc_generar_evidencia: oc.generar_evidencia as unknown as OcTool,
  oc_crear: oc.crear as unknown as OcTool
};

const toolDefinitions: ToolDefinition[] = Object.entries(tools).map(([name, tool]) => {
  const properties: Record<string, unknown> = {};
  for (const [key, shape] of Object.entries(tool.args)) {
    properties[key] = {
      type: shape instanceof z.ZodBoolean ? "boolean" : "string",
      description: (shape as z.ZodType & { description?: string }).description
    };
  }
  return {
    name,
    description: tool.description,
    parameters: { type: "object", properties, required: Object.keys(tool.args).filter((key) => !tool.args[key].isOptional()) }
  };
});

await mkdir(join(directory, "out"), { recursive: true });

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, provider: "OpenAI-compatible", model: process.env.OPENAI_MODEL ?? "gpt-4o-mini" });
});

app.get("/api/sessions/:id", (req, res) => {
  res.json({ sessionId: req.params.id, messages: (sessions.get(req.params.id) ?? []).filter((x) => x.role !== "system") });
});

app.post("/api/chat", async (req, res) => {
  const body = z.object({ sessionId: z.string().min(1), message: z.string().min(1) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ reply: "Solicitud inválida.", toolCalls: [], needsConfirmation: false });

  const { sessionId, message } = body.data;
  const history = sessions.get(sessionId) ?? [{ role: "system", content: systemPrompt }];
  history.push({ role: "user", content: message });

  const explicitConfirmation = /\b(confirmo|sí|si|aprobar|continúa|continua|adelante)\b/i.test(message);
  if (explicitConfirmation) confirmations.set(sessionId, true);

  const toolCalls: Array<{ name: string; args: Record<string, unknown>; result: unknown }> = [];
  let needsConfirmation = false;
  let reply = "";

  try {
    for (let iteration = 0; iteration < 25; iteration++) {
      const turn = await llm.enviar(history, toolDefinitions);
      if (turn.type === "text") {
        reply = turn.text;
        needsConfirmation = /\bconfirma\b/i.test(reply) || /\bconfirmación\b/i.test(reply);
        break;
      }
      for (const call of turn.calls) {
        const tool = tools[call.name];
        if (!tool) {
          const result = { ok: false, error: `Herramienta desconocida: ${call.name}` };
          toolCalls.push({ name: call.name, args: call.args, result });
          history.push({ role: "tool", content: JSON.stringify(result) });
          continue;
        }
        const schema = z.object(tool.args);
        const parsed = schema.safeParse(call.args);
        let resultText: string;
        if (!parsed.success) {
          resultText = JSON.stringify({ ok: false, error: parsed.error.issues.map((issue) => issue.message).join("; ") });
        } else {
          const args = parsed.data as Record<string, unknown>;
          if (call.name === "oc_crear" && confirmations.get(sessionId) === true) args.confirmado = true;
          resultText = await tool.execute(args as never, { directory, sessionId });
        }
        const result = JSON.parse(resultText) as unknown;
        toolCalls.push({ name: call.name, args: call.args, result });
        history.push({ role: "assistant", content: `Llamada ${call.name}` });
        history.push({ role: "tool", content: resultText });
        await appendFile(join(directory, "out/log.jsonl"), JSON.stringify({ ts: new Date().toISOString(), sessionId, name: call.name, args: call.args, result }) + "\n").catch(() => undefined);
        if (call.name === "oc_crear") confirmations.delete(sessionId);
      }
    }
    if (!reply) reply = "Alcancé el límite de 25 iteraciones. Indica qué dato o confirmación falta.";
  } catch (error) {
    reply = error instanceof Error ? `Error del proveedor LLM: ${error.message}` : "Error inesperado del proveedor LLM.";
  }

  history.push({ role: "assistant", content: reply });
  sessions.set(sessionId, history);
  res.json({ reply, toolCalls, needsConfirmation });
});

app.listen(Number(process.env.PORT ?? 3000), () => {
  console.log(`Agente disponible en http://localhost:${process.env.PORT ?? 3000}`);
});
