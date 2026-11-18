# Solución

## 1. Problema y usuarios
La digitación manual de órdenes de compra genera errores de proveedor, centro de costo, autoridad y pagos. Le duele a la analista administrativa y a contabilidad; el agente automatiza controles y deja excepciones para decisión humana.

## 2. Arquitectura
Front HTML/JS → Express → ciclo agente → adaptador LLM → herramientas `oc_*` → fixtures maestros y out. El comportamiento vive en `agent/prompt.md`, el conocimiento en `src/knowledge/ordenes-compra.md`, la ejecución en `src/tools/oc.ts` y el SAP en `src/sap/`.

## 3. Ciclo del agente
El servidor mantiene sesiones en memoria, ejecuta hasta 25 iteraciones herramienta/modelo y valida cada argumento con Zod. Cuando aparecen confirmaciones, termina el turno; solo un mensaje explícito permite `confirmado: true`.

## 4. Modelo
Se implementó una interfaz compatible con APIs OpenAI. `gpt-4o-mini` es económico y adecuado para llamadas estructuradas. Estimación orientativa: menos de US$0.02 por caso normal, según prompts, herramientas y proveedores.

## 5. Matriz RC1-RC10
- RC1 proveedor activo por NIT/nombre.
- RC2 aprobación “Aprobado” y aprobador del centro.
- RC3 tope del aprobador.
- RC4 centro y subárea.
- RC5 diferencia de cotización.
- RC6 IVA derivado.
- RC7 pago derivado.
- RC8 factura anterior.
- RC9 aprobación anterior.
- RC10 cantidad x unitario.

RC2 fue la más delicada porque combina texto, identidad y autoridad del centro.

## 6. SAP real
Elegiría OData `API_PURCHASEORDER_PROCESS_SRV` por API reusable y modelo semántico SAP, si el landscape y permisos lo permiten. Mapearía sociedad, organización, proveedor, posiciones, centro/subárea e IVA a entidades y estructuras PurchaseOrder; el servicio real debe confirmarse con un cliente SAP.
Usaría OAuth 2.0 o certificado con secretos en el gestor de secretos, nunca en prompt ni front. Cada OC tendría referencia de solicitud como clave de idempotencia; ante reintentos buscaría antes de crear. Ante respuesta parcial guardaría correlation ID y estado, reconciliaría por referencia y nunca asumía éxito.
Plan B: generar payload JSON/CSV de carga y PDF/TXT listo para revisión manual.

## 7. OC retroactivas
El hallazgo debe medirse sin normalizar el desvío: el agente identifica factura anterior y exige confirmación. Propongo una política configurable: tolerar excepciones trazadas, pero alertar al cierre mensual y exigir cotización previa en compras recurrentes.

## 8. Decisiones
1. Express/HTML: velocidad y facilidad de defensa frente a un framework pesado.
2. Archivos: reúnen persistencia requerida sin base de datos.
3. OpenAI-compatible: cambia proveedor mediante una variable, no el ciclo.

## 9. Supuestos
Los fixtures están completos y los datos JSON son fuente normalizada. Las fechas ISO son comparables. Los campos opcionales deben derivarse o confirmarse.

## 10. Cobertura
| HU | Estado |
|---|---|
| Leer paquete | Hecho |
| Validar controles | Hecho |
| Construir payload | Hecho |
| Evidencia TXT/PDF | Hecho |
| Crear OC/idempotencia/control | Hecho |
| Excel/PDF reales | Parcial |
| Despliegue público | Por ejecutar |

## 11. Uso de IA
Usé Copilot SDK para analizar el PRD, construir herramientas, implementar front/back y documentación. Se descartaron cambios automáticos de montos y una UI sin trazabilidad de llamadas.

## 12. Riesgos
Proveedores, autorizaciones o modelos reales requieren controles de acceso, auditoría externa, monitoreo y credenciales gestionadas. Los datos de LLM deben excluir datos sensibles y las conversaciones deben cifrarse.
