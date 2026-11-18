import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { OrdenCompra, SapAdapter } from "./adapter.js";

export class MockSapAdapter implements SapAdapter {
  constructor(private directory: string) {}

  async consultarProveedor(nit: string) {
    const maestros = JSON.parse(await readFile(join(this.directory, "fixtures/reto-03/maestros/proveedores.json"), "utf8")) as Array<{ nit: string; codigo_sap: string; activo: boolean }>;
    const item = maestros.find((x) => x.nit === nit);
    return item ? { codigo_sap: item.codigo_sap, activo: item.activo } : null;
  }

  async buscarOrdenPorReferencia(solicitudId: string) {
    const file = join(this.directory, "out/sap/ordenes.jsonl");
    try {
      const text = await readFile(file, "utf8");
      for (const line of text.trim().split("\n").filter(Boolean).reverse()) {
        const row = JSON.parse(line) as { orden: OrdenCompra; numero_oc: string };
        if (row.orden.referencia.solicitud_id === solicitudId) return { numero_oc: row.numero_oc };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return null;
  }

  async crearOrden(orden: OrdenCompra) {
    await mkdir(join(this.directory, "out/sap"), { recursive: true });
    const existing = await this.buscarOrdenPorReferencia(orden.referencia.solicitud_id);
    if (existing) return { numero_oc: existing.numero_oc, fecha: new Date().toISOString().slice(0, 10) };

    let next = 4500000001;
    try {
      const text = await readFile(join(this.directory, "out/sap/ordenes.jsonl"), "utf8");
      const numbers = text.trim().split("\n").filter(Boolean).map((line) => Number(JSON.parse(line).numero_oc));
      if (numbers.length) next = Math.max(...numbers) + 1;
    } catch {}

    const fecha = new Date().toISOString().slice(0, 10);
    await appendFile(join(this.directory, "out/sap/ordenes.jsonl"), JSON.stringify({ numero_oc: String(next), fecha, orden }) + "\n", "utf8");
    return { numero_oc: String(next), fecha };
  }
}
