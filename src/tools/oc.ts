import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { OrdenCompraSchema, type OrdenCompra } from "../sap/adapter.js";
import { PDFDocument, StandardFonts } from "pdf-lib";

type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string; bloqueos?: string[]; confirmaciones?: string[] };
type Context = { directory: string; sessionId: string };

type Solicitud = {
  solicitud_id: string; solicitante: string; proveedor_nombre: string; proveedor_nit?: string;
  descripcion: string; centro_costo: string; subarea: string; cantidad: number;
  valor_unitario: number; valor_total: number; moneda: "COP" | "USD";
  indicador_iva?: string; condiciones_pago?: string; fecha_solicitud: string;
};

type Paquete = {
  correo: { id: string; de: string; asunto: string; fecha: string };
  solicitud: Solicitud;
  cotizacion: { proveedor: string; nit: string | null; total: number; moneda: "COP" | "USD"; validez_hasta: string | null; texto: string } | null;
  aprobacion: { de: string; fecha: string; aprobado: boolean; texto: string } | null;
  factura: { numero: string; fecha: string; total: number } | null;
};

const cleanText = (value: string) => value
  .replaceAll("Ã¡", "á").replaceAll("Ã©", "é").replaceAll("Ã­", "í")
  .replaceAll("Ã³", "ó").replaceAll("Ãº", "ú").replaceAll("Ã±", "ñ")
  .replaceAll("Ã", "Í").replaceAll("â†’", "→");

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"));
}

function caseDir(directory: string, caso: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(caso)) throw new Error("Nombre de caso inválido.");
  return join(directory, "fixtures/reto-03/solicitudes", caso);
}

function parseMoney(text: string, label: string): number {
  const match = text.match(new RegExp(`${label}:\\s*COP\\s*([\\d.]+)`, "i"));
  if (!match) throw new Error(`No fue posible leer ${label} de la cotización.`);
  return Number(match[1].replaceAll(".", ""));
}

async function loadMasters(directory: string) {
  const base = join(directory, "fixtures/reto-03/maestros");
  const [proveedores, centros, iva, pagos] = await Promise.all([
    readJson(join(base, "proveedores.json")),
    readJson(join(base, "centros-costo.json")),
    readJson(join(base, "indicadores-iva.json")),
    readJson(join(base, "condiciones-pago.json"))
  ]);
  return {
    proveedores: proveedores as Array<{ codigo_sap: string; nit: string; nombre: string; condiciones_pago_default: string; indicador_iva_default: string; activo: boolean }>,
    centros: centros as Array<{ centro_costo: string; subareas: string[]; aprobadores: Array<{ email: string; tope: number }> }>,
    iva: iva as Array<{ codigo: string; descripcion: string; tasa: number }>,
    pagos: pagos as Array<{ codigo: string; descripcion: string; dias: number }>
  };
}

async function controlLog(directory: string, row: Record<string, unknown>) {
  await mkdir(join(directory, "out"), { recursive: true });
  const file = join(directory, "out/control.csv");
  let exists = true;
  try { await readFile(file, "utf8"); } catch { exists = false; }
  const values = [
    row.solicitud_id, row.resultado, row.numero_oc ?? "", row.retroactiva ?? false,
    JSON.stringify(row.bloqueos ?? []), JSON.stringify(row.confirmaciones ?? []), new Date().toISOString()
  ];
  if (!exists) await writeFile(file, "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts\n", "utf8");
  await appendFile(file, values.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",") + "\n", "utf8");
}

export const leer_paquete = {
  description: "Lee y normaliza correo, solicitud, cotización, aprobación y factura de una solicitud.",
  args: { caso: z.string().describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes.") },
  async execute(args: { caso: string }, ctx: Context): Promise<string> {
    try {
      const dir = caseDir(ctx.directory, args.caso);
      const [correoRaw, solicitudRaw, aprobacionRaw] = await Promise.all([
        readJson(join(dir, "correo.json")), readJson(join(dir, "solicitud.json")), readJson(join(dir, "aprobacion.json"))
      ]);
      const correo = correoRaw as Record<string, unknown>;
      const solicitud = solicitudRaw as Solicitud;
      if (!solicitud.solicitud_id || !Number.isFinite(solicitud.valor_total)) throw new Error("Solicitud incompleta o con monto no numérico.");

      let cotizacion: Paquete["cotizacion"] = null;
      try {
        const textoRaw = await readFile(join(dir, "cotizacion.txt"), "utf8");
        const texto = cleanText(textoRaw);
        const proveedor = texto.match(/Proveedor:\s*(.+)/)?.[1]?.trim() ?? "";
        const nitRaw = texto.match(/NIT:\s*([\d.]+)/)?.[1] ?? null;
        const nit = nitRaw?.replaceAll(".", "") ?? null;
        const total = parseMoney(texto, "TOTAL");
        cotizacion = { proveedor, nit, total, moneda: solicitud.moneda, validez_hasta: null, texto };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      const approval = aprobacionRaw as { de: string; fecha: string; cuerpo: string };
      const aprobacion = {
        de: approval.de,
        fecha: approval.fecha,
        aprobado: /\bAprobado\b/i.test(approval.cuerpo),
        texto: cleanText(approval.cuerpo)
      };

      let factura: Paquete["factura"] = null;
      try {
        const raw = cleanText(await readFile(join(dir, "factura.txt"), "utf8"));
        const numero = raw.match(/No\.\s*(\S+)/)?.[1] ?? "sin-número";
        const fecha = raw.match(/Fecha de emisión:\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
        const total = parseMoney(raw, "TOTAL");
        if (!fecha) throw new Error("La factura no incluye una fecha válida.");
        factura = { numero, fecha, total };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      const data: Paquete = {
        correo: { id: String(correo.id), de: String(correo.de), asunto: cleanText(String(correo.asunto)), fecha: String(correo.fecha) },
        solicitud: { ...solicitud, descripcion: cleanText(solicitud.descripcion), proveedor_nombre: cleanText(solicitud.proveedor_nombre) },
        cotizacion,
        aprobacion,
        factura
      };
      return JSON.stringify({ ok: true, data });
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Paquete no disponible." } satisfies ToolResult);
    }
  }
};

export const validar = {
  description: "Valida el paquete contra proveedores, centro de costo, aprobadores, IVA, pago, cotización y fecha.",
  args: { caso: z.string().describe("Nombre del caso."), paquete: z.record(z.unknown()).describe("Paquete devuelto por oc_leer_paquete.") },
  async execute(args: { caso: string; paquete: Paquete }, ctx: Context): Promise<string> {
    try {
      const masters = await loadMasters(ctx.directory);
      const p = args.paquete;
      const s = p.solicitud;
      const bloqueos: string[] = [];
      const confirmaciones: string[] = [];
      const derivados: Record<string, unknown> = {};
      let retroactiva = false;

      const proveedor = masters.proveedores.find((x) =>
        (s.proveedor_nit && x.nit === s.proveedor_nit) ||
        x.nombre.toLocaleLowerCase("es") === s.proveedor_nombre.toLocaleLowerCase("es")
      );
      if (!proveedor || !proveedor.activo) bloqueos.push("RC1: proveedor inexistente o inactivo.");
      else {
        if (!s.indicador_iva) {
          derivados.indicador_iva = proveedor.indicador_iva_default;
          confirmaciones.push(`RC6: indicador IVA derivado como ${proveedor.indicador_iva_default}; confirme el IVA.`);
        }
        if (!s.condiciones_pago) {
          derivados.condiciones_pago = proveedor.condiciones_pago_default;
          derivedDerive(derivados, "condiciones_pago_fuente", "maestro.proveedores");
        }
      }

      const centro = masters.centros.find((x) => x.centro_costo === s.centro_costo);
      if (!centro) bloqueos.push("RC4: centro de costo inexistente.");
      else {
        if (!centro.subareas.includes(s.subarea)) bloqueos.push("RC4: subárea no pertenece al centro de costo.");
        if (!p.aprobacion?.aprobado) bloqueos.push("RC2: la aprobación no existe o no contiene Aprobado.");
        else {
          const aprobador = centro.aprobadores.find((x) => x.email.toLocaleLowerCase() === p.aprobacion?.de.toLocaleLowerCase());
          if (!aprobador) bloqueos.push("RC2: el aprobador no pertenece al centro de costo.");
          else if (s.valor_total > aprobador.tope) bloqueos.push(`RC3: valor supera el tope del aprobador (${aprobador.tope}).`);
        }
      }

      if (Math.abs(s.cantidad * s.valor_unitario - s.valor_total) > 1) bloqueos.push("RC10: cantidad por valor unitario no coincide con el valor total.");
      if (p.cotizacion) {
        const diferencia = s.valor_total === 0 ? 1 : Math.abs(p.cotizacion.total - s.valor_total) / s.valor_total;
        if (diferencia > 0.02) confirmaciones.push(`RC5: cotización COP ${p.cotizacion.total} ≠ solicitud COP ${s.valor_total}.`);
      } else confirmaciones.push("RC5: no existe cotización adjunta.");
      if (p.factura && p.factura.fecha < s.fecha_solicitud) {
        retroactiva = true;
        confirmaciones.push(`RC8: factura ${p.factura.numero} emitida ${p.factura.fecha}, antes de la solicitud ${s.fecha_solicitud}.`);
      }
      if (p.aprobacion && p.aprobacion.fecha.slice(0, 10) < s.fecha_solicitud) confirmaciones.push("RC9: aprobación anterior a la fecha de solicitud.");

      const result = { apta: bloqueos.length === 0, bloqueos, confirmaciones, derivados, retroactiva };
      await controlLog(ctx.directory, { solicitud_id: s.solicitud_id, resultado: bloqueos.length ? "bloqueado" : confirmaciones.length ? "pendiente" : "apto", retroactiva, bloqueos, confirmaciones });
      return JSON.stringify({ ok: true, data: result } satisfies ToolResult);
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Validación fallida." } satisfies ToolResult);
    }
  }
};

function derivedDerive(target: Record<string, unknown>, key: string, value: unknown) {
  target[key] = value;
}

export const construir_payload = {
  description: "Construye el payload trazable de la orden de compra y guarda trazabilidad.",
  args: {
    caso: z.string().describe("Nombre del caso."),
    paquete: z.record(z.unknown()).describe("Paquete normalizado."),
    derivados: z.record(z.unknown()).describe("Valores derivados obtenidos por oc_validar.")
  },
  async execute(args: { caso: string; paquete: Paquete; derivados: Record<string, unknown> }, ctx: Context): Promise<string> {
    try {
      const s = args.paquete.solicitud;
      const masters = await loadMasters(ctx.directory);
      const provider = masters.proveedores.find((x) => s.proveedor_nit ? x.nit === s.proveedor_nit : x.nombre === s.proveedor_nombre);
      if (!provider) throw new Error("No se puede construir: proveedor ausente en maestros.");
      const center = masters.centros.find((x) => x.centro_costo === s.centro_costo);
      const approver = center?.aprobadores.find((x) => x.email.toLocaleLowerCase() === args.paquete.aprobacion?.de.toLocaleLowerCase());
      if (!approver) throw new Error("No se puede construir: aprobador ausente.");

      const evidencia = await readEvidenceSha(ctx.directory, args.caso);
      const indicador = s.indicador_iva ?? String(args.derivados.indicador_iva ?? provider.indicador_iva_default);
      const pagos = s.condiciones_pago ?? String(args.derivados.condiciones_pago ?? provider.condiciones_pago_default);
      const order: OrdenCompra = {
        referencia: {
          solicitud_id: s.solicitud_id,
          correo_id: args.paquete.correo.id,
          cotizacion_ref: args.paquete.cotizacion?.texto.match(/COTIZACI(?:ÓN|ON)\s+([A-Z0-9-]+)/i)?.[1] ?? null
        },
        sociedad: "1000",
        organizacion_compras: "1000",
        proveedor: { codigo_sap: provider.codigo_sap, nit: provider.nit, nombre: provider.nombre },
        moneda: s.moneda,
        condiciones_pago: pagos,
        aprobador: { email: approver.email, fecha_aprobacion: args.paquete.aprobacion?.fecha ?? "", evidencia_sha256: evidencia },
        posiciones: [{
          numero: 10,
          descripcion: s.descripcion.slice(0, 40),
          cantidad: s.cantidad,
          unidad: "UN",
          precio_unitario: s.valor_unitario,
          centro_costo: s.centro_costo,
          subarea: s.subarea,
          indicador_iva: indicador
        }],
        excepciones: []
      };
      const parsed = OrdenCompraSchema.parse(order);
      const out = join(ctx.directory, "out", args.caso);
      await mkdir(out, { recursive: true });
      const trace = {
        solicitud_id: s.solicitud_id,
        campos: {
          proveedor: "solicitud+maestro.proveedores",
          descripcion: "solicitud",
          centro_costo: "solicitud",
          subarea: "solicitud",
          cantidad: "solicitud",
          precio_unitario: "solicitud",
          valor_total: "solicitud",
          moneda: "solicitud",
          indicador_iva: s.indicador_iva ? "solicitud" : "derivado",
          condiciones_pago: s.condiciones_pago ? "solicitud" : "derivado"
        }
      };
      await writeFile(join(out, "trazabilidad.json"), JSON.stringify(trace, null, 2), "utf8");
      return JSON.stringify({ ok: true, data: { ...parsed, ruta_trazabilidad: `out/${args.caso}/trazabilidad.json` } } satisfies ToolResult);
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "No fue posible construir el payload." } satisfies ToolResult);
    }
  }
};

async function readEvidenceSha(directory: string, caso: string) {
  const file = join(directory, "out", caso, "aprobacion.txt");
  try {
    const text = await readFile(file, "utf8");
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(text).digest("hex");
  } catch {
    return "";
  }
}

export const generar_evidencia = {
  description: "Genera la evidencia TXT y opcionalmente PDF del correo de aprobación.",
  args: { caso: z.string().describe("Nombre del caso.") },
  async execute(args: { caso: string }, ctx: Context): Promise<string> {
    try {
      const dir = caseDir(ctx.directory, args.caso);
      const approval = await readJson(join(dir, "aprobacion.json")) as { de: string; para: string; fecha: string; asunto: string; cuerpo: string };
      const out = join(ctx.directory, "out", args.caso);
      await mkdir(out, { recursive: true });
      const headers = `de: ${approval.de}\npara: ${approval.para}\nfecha: ${approval.fecha}\nasunto: ${cleanText(approval.asunto)}\n\n${cleanText(approval.cuerpo)}\n`;
      await writeFile(join(out, "aprobacion.txt"), headers, "utf8");
      const { createHash } = await import("node:crypto");
      const sha256 = createHash("sha256").update(headers).digest("hex");

      const pdf = await PDFDocument.create();
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      const page = pdf.addPage([595, 842]);
      const lines = headers.split("\n");
      lines.forEach((line, index) => page.drawText(line.slice(0, 120), { x: 40, y: 800 - index * 16, size: 10, font }));
      await writeFile(join(out, "aprobacion.pdf"), await pdf.save());
      return JSON.stringify({ ok: true, data: { ruta: `out/${args.caso}/aprobacion.txt`, ruta_pdf: `out/${args.caso}/aprobacion.pdf`, sha256 } } satisfies ToolResult);
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "No fue posible generar la evidencia." } satisfies ToolResult);
    }
  }
};

export const crear = {
  description: "Crea la orden en el SAP simulado solo si la orden fue aprobada y las confirmaciones están explícitas.",
  args: {
    caso: z.string().describe("Nombre del caso."),
    payload: z.record(z.unknown()).describe("Orden de compra construida."),
    confirmado: z.boolean().optional().describe("True solo si el humano confirmó todas las excepciones.")
  },
  async execute(args: { caso: string; payload: OrdenCompra & { ruta_trazabilidad?: string }; confirmado?: boolean }, ctx: Context): Promise<string> {
    try {
      const parsed = OrdenCompraSchema.parse(args.payload);
      const validation = await thisValidation(ctx.directory, args.caso);
      if (!validation.apta) {
        await controlLog(ctx.directory, { solicitud_id: parsed.referencia.solicitud_id, resultado: "bloqueado", retroactiva: validation.retroactiva, bloqueos: validation.bloqueos, confirmaciones: validation.confirmaciones });
        return JSON.stringify({ ok: false, error: "No se creó la OC: existen bloqueos.", bloqueos: validation.bloqueos } satisfies ToolResult);
      }
      if (validation.confirmaciones.length && args.confirmado !== true) {
        await controlLog(ctx.directory, { solicitud_id: parsed.referencia.solicitud_id, resultado: "pendiente", retroactiva: validation.retroactiva, bloqueos: [], confirmaciones: validation.confirmaciones });
        return JSON.stringify({ ok: false, error: "Confirmación humana pendiente.", confirmaciones: validation.confirmaciones } satisfies ToolResult);
      }

      const { MockSapAdapter } = await import("../sap/mock.js");
      const sap = new MockSapAdapter(ctx.directory);
      const existing = await sap.buscarOrdenPorReferencia(parsed.referencia.solicitud_id);
      const created = await sap.crearOrden(parsed);
      await controlLog(ctx.directory, { solicitud_id: parsed.referencia.solicitud_id, resultado: "creado", numero_oc: created.numero_oc, retroactiva: validation.retroactiva, bloqueos: [], confirmaciones: validation.confirmaciones });
      return JSON.stringify({ ok: true, data: { numero_oc: created.numero_oc, fecha: created.fecha, idempotente: Boolean(existing) } } satisfies ToolResult);
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "No fue posible crear la OC." } satisfies ToolResult);
    }
  }
};

async function thisValidation(directory: string, caso: string) {
  const dir = caseDir(directory, caso);
  const [solRaw, approvalRaw] = await Promise.all([readJson(join(dir, "solicitud.json")), readJson(join(dir, "aprobacion.json"))]);
  const s = solRaw as Solicitud;
  const approval = approvalRaw as { de: string; fecha: string; cuerpo: string };
  const correoRaw = await readJson(join(dir, "correo.json")) as { id: string; de: string; asunto: string; fecha: string };
  let cotizacion = null;
  try {
    const text = cleanText(await readFile(join(dir, "cotizacion.txt"), "utf8"));
    cotizacion = { total: parseMoney(text, "TOTAL"), proveedor: "", nit: null, moneda: s.moneda, validez_hasta: null, texto: text };
  } catch {}
  let factura = null;
  try {
    const text = cleanText(await readFile(join(dir, "factura.txt"), "utf8"));
    factura = { numero: text.match(/No\.\s*(\S+)/)?.[1] ?? "sin-número", fecha: text.match(/Fecha de emisión:\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? "", total: parseMoney(text, "TOTAL") };
  } catch {}
  const paquete: Paquete = { correo: { id: correoRaw.id, de: correoRaw.de, asunto: correoRaw.asunto, fecha: correoRaw.fecha }, solicitud: s, cotizacion, aprobacion: { de: approval.de, fecha: approval.fecha, aprobado: /\bAprobado\b/i.test(approval.cuerpo), texto: approval.cuerpo }, factura };
  const tools = { paquetes: true };
  void tools;
  const masters = await loadMasters(directory);
  const bloqueos: string[] = [];
  const confirmaciones: string[] = [];
  let retroactiva = false;
  const provider = masters.proveedores.find((x) => s.proveedor_nit ? x.nit === s.proveedor_nit : x.nombre.toLocaleLowerCase("es") === s.proveedor_nombre.toLocaleLowerCase("es"));
  if (!provider || !provider.activo) bloqueos.push("RC1: proveedor inexistente o inactivo.");
  const center = masters.centros.find((x) => x.centro_costo === s.centro_costo);
  if (!center) bloqueos.push("RC4: centro de costo inexistente.");
  else {
    if (!center.subareas.includes(s.subarea)) bloqueos.push("RC4: subárea no pertenece al centro de costo.");
    const approver = center.aprobadores.find((x) => x.email.toLocaleLowerCase() === approval.de.toLocaleLowerCase());
    if (!/\bAprobado\b/i.test(approval.cuerpo) || !approver) bloqueos.push("RC2: aprobación ausente o aprobador sin autoridad.");
    else if (s.valor_total > approver.tope) bloqueos.push("RC3: valor supera el tope del aprobador.");
  }
  if (Math.abs(s.cantidad * s.valor_unitario - s.valor_total) > 1) bloqueos.push("RC10: cantidad por valor unitario no coincide.");
  if (cotizacion) {
    const diff = s.valor_total === 0 ? 1 : Math.abs(cotizacion.total - s.valor_total) / s.valor_total;
    if (diff > 0.02) confirmaciones.push(`RC5: cotización COP ${cotizacion.total} ≠ solicitud COP ${s.valor_total}.`);
  } else confirmaciones.push("RC5: no existe cotización.");
  if (!s.indicador_iva) confirmaciones.push("RC6: confirme el indicador IVA derivado.");
  if (factura && factura.fecha < s.fecha_solicitud) { retroactiva = true; confirmaciones.push("RC8: OC retroactiva."); }
  if (approval.fecha.slice(0, 10) < s.fecha_solicitud) confirmaciones.push("RC9: aprobación anterior a la solicitud.");
  return { apta: bloqueos.length === 0, bloqueos, confirmaciones, retroactiva };
}
