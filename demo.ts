import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import * as oc from "./src/tools/oc.js";
import type { OrdenCompra } from "./src/sap/adapter.js";

type Result = { ok: boolean; data?: unknown; error?: string; confirmaciones?: string[]; bloqueos?: string[] };
type Context = { directory: string; sessionId: string };
const directory = resolve(".");
const ctx: Context = { directory, sessionId: "demo" };
const casos = ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"];

async function runTool<T>(tool: { execute(args: T, ctx: Context): Promise<string> }, args: T): Promise<Result> {
  return JSON.parse(await tool.execute(args, ctx)) as Result;
}

await rm(resolve(directory, "out"), { recursive: true, force: true });

for (const caso of casos) {
  const lectura = await runTool(oc.leer_paquete, { caso });
  if (!lectura.ok) {
    console.log(`${caso}: motivo=${lectura.error}`);
    continue;
  }
  const paquete = lectura.data as Record<string, unknown>;
  const validacion = await runTool(oc.validar, { caso, paquete });
  if (!validacion.ok) {
    console.log(`${caso}: motivo=${validacion.error}`);
    continue;
  }
  const data = validacion.data as { apta: boolean; bloqueos: string[]; confirmaciones: string[]; derivados: Record<string, unknown>; retroactiva: boolean };
  let numeroOc = "-";
  if (!data.apta) numeroOc = "motivo: bloqueado";
  else if (data.confirmaciones.length) {
    numeroOc = "motivo: pendiente confirmación";
  } else {
    const evidencia = await runTool(oc.generar_evidencia, { caso });
    if (!evidencia.ok) numeroOc = `motivo: ${evidencia.error}`;
    else {
      const payload = await runTool(oc.construir_payload, { caso, paquete, derivados: data.derivados });
      if (!payload.ok) numeroOc = `motivo: ${payload.error}`;
      else {
        const payloadData = payload.data as Record<string, unknown>;
        const creado = await runTool(oc.crear, { caso, payload: payloadData as unknown as OrdenCompra, confirmado: false });
        if (creado.ok) numeroOc = String((creado.data as { numero_oc: string }).numero_oc);
        else numeroOc = `motivo: ${creado.error}`;
      }
    }
  }
  console.log(`${caso}: apta=${data.apta}, bloqueos=${JSON.stringify(data.bloqueos)}, confirmaciones=${JSON.stringify(data.confirmaciones)}, retroactiva=${data.retroactiva}, OC=${numeroOc}`);
}

// Confirmación explícita del caso solicitado.
const sol004 = await runTool(oc.leer_paquete, { caso: "sol-004" });
const sol004Data = sol004.data as Record<string, unknown>;
const sol004Valid = await runTool(oc.validar, { caso: "sol-004", paquete: sol004Data });
const sol004Validation = sol004Valid.data as { derivados: Record<string, unknown> };
await runTool(oc.generar_evidencia, { caso: "sol-004" });
const sol004Payload = await runTool(oc.construir_payload, { caso: "sol-004", paquete: sol004Data, derivados: sol004Validation.derivados });
const sol004Confirmado = await runTool(oc.crear, { caso: "sol-004", payload: sol004Payload.data as unknown as OrdenCompra, confirmado: true });
console.log(`sol-004 confirmado=true: ${JSON.stringify(sol004Confirmado.data ?? sol004Confirmado.error)}`);

// Idempotencia: repetir sol-001 sin crear una segunda OC.
const sol001 = await runTool(oc.leer_paquete, { caso: "sol-001" });
const sol001Data = sol001.data as Record<string, unknown>;
const sol001Valid = await runTool(oc.validar, { caso: "sol-001", paquete: sol001Data });
const sol001Validation = sol001Valid.data as { derivados: Record<string, unknown> };
await runTool(oc.generar_evidencia, { caso: "sol-001" });
const sol001Payload = await runTool(oc.construir_payload, { caso: "sol-001", paquete: sol001Data, derivados: sol001Validation.derivados });
const sol001Repeat = await runTool(oc.crear, { caso: "sol-001", payload: sol001Payload.data as unknown as OrdenCompra, confirmado: false });
console.log(`sol-001 repetido: ${JSON.stringify(sol001Repeat.data)}`);
