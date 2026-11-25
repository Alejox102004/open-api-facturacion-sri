/**
 * Ayudas del RIDE para la nota de crédito (tipo 04). Trabajan sobre el objeto
 * que devuelve xml2js con explicitArray: false.
 */

/** Campo adicional de xml2js: <campoAdicional nombre="x">valor</campoAdicional> */
export interface CampoAdicionalXml {
  $?: { nombre?: string };
  _?: string;
}

export interface TotalImpuestoXml {
  codigo?: string;
  codigoPorcentaje?: string;
  baseImponible?: string;
  valor?: string;
}

export interface InfoNotaCreditoXml {
  codDocModificado?: string;
  numDocModificado?: string;
  fechaEmisionDocSustento?: string;
  motivo?: string;
  totalSinImpuestos?: string;
  valorModificacion?: string;
  totalConImpuestos?: {
    totalImpuesto?: TotalImpuestoXml | TotalImpuestoXml[];
  };
}

export interface DetalleNotaCreditoXml {
  codigoInterno?: string;
  codigoPrincipal?: string;
  descuento?: string;
  [campo: string]: unknown;
}

export interface NotaCreditoXml {
  infoTributaria?: Record<string, unknown>;
  infoNotaCredito?: InfoNotaCreditoXml & Record<string, unknown>;
  detalles?: { detalle?: DetalleNotaCreditoXml | DetalleNotaCreditoXml[] };
  infoAdicional?: {
    campoAdicional?: CampoAdicionalXml | CampoAdicionalXml[];
  };
}

/**
 * Extrae las secciones de una nota de crédito con la misma forma que usa el
 * RIDE de la factura (los detalles traen codigoPrincipal).
 */
export function leerNotaCredito(nc: NotaCreditoXml): {
  info: InfoNotaCreditoXml & Record<string, unknown>;
  it: Record<string, unknown>;
  detalles: DetalleNotaCreditoXml[];
  adicional: CampoAdicionalXml[];
  modificacion: DatosModificacion;
} {
  const info = nc.infoNotaCredito ?? {};
  return {
    info,
    modificacion: {
      documento: documentoModificado(
        info.codDocModificado,
        info.numDocModificado,
      ),
      fecha: info.fechaEmisionDocSustento ?? '',
      motivo: info.motivo ?? '',
    },
    it: nc.infoTributaria ?? {},
    // En la nota de crédito el código se llama codigoInterno
    detalles: lista(nc.detalles?.detalle).map((d) => ({
      ...d,
      codigoPrincipal: d.codigoPrincipal ?? d.codigoInterno,
    })),
    adicional: lista(nc.infoAdicional?.campoAdicional),
  };
}

export type FilaTotal = [string, string, boolean];

/** Datos del documento que modifica la nota de crédito, listos para el RIDE */
export interface DatosModificacion {
  /** p. ej. "FACTURA 001-001-000000123" */
  documento: string;
  /** Fecha de emisión del documento sustento (dd/mm/yyyy) */
  fecha: string;
  /** Razón de la modificación */
  motivo: string;
}

/** Nombre del documento sustento según su código (tabla 4 del SRI) */
const DOC_SUSTENTO: Record<string, string> = {
  '01': 'FACTURA',
  '03': 'LIQUIDACIÓN DE COMPRA',
  '04': 'NOTA DE CRÉDITO',
  '05': 'NOTA DE DÉBITO',
  '06': 'GUÍA DE REMISIÓN',
  '07': 'COMPROBANTE DE RETENCIÓN',
};

/** Etiqueta de la tarifa de IVA según su código de porcentaje (tabla 17) */
const TARIFA_IVA: Record<string, string> = {
  '0': 'IVA 0%',
  '2': 'IVA 12%',
  '3': 'IVA 14%',
  '4': 'IVA 15%',
  '5': 'IVA 5%',
  '6': 'NO OBJETO DE IVA',
  '7': 'EXENTO DE IVA',
  '8': 'IVA 8%',
  '10': 'IVA 13%',
};

/** Códigos de porcentaje de IVA que no generan impuesto */
const IVA_SIN_VALOR = ['0', '6', '7'];

function lista<T>(v: T | T[] | undefined): T[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function monto(v: string | number | undefined): string {
  const n = parseFloat(String(v ?? ''));
  return isNaN(n) ? '0.00' : n.toFixed(2);
}

/** "FACTURA 001-001-000000123" a partir del código y número del documento */
export function documentoModificado(
  codDoc: string | undefined,
  numDoc: string | undefined,
): string {
  const cod = codDoc ?? '';
  const nombre = DOC_SUSTENTO[cod] ?? `DOCUMENTO ${cod}`;
  return `${nombre} ${numDoc ?? ''}`.trim();
}

/** Valor de un campo de info adicional por nombre (sin distinguir mayúsculas) */
export function campoAdicional(
  adicional: CampoAdicionalXml[],
  nombre: string,
): string | undefined {
  const campo = adicional.find(
    (a) => (a?.$?.nombre ?? '').toLowerCase() === nombre.toLowerCase(),
  );
  return campo ? (campo._ ?? '') : undefined;
}

/**
 * Filas del resumen de una nota de crédito: subtotal por cada tarifa de IVA
 * presente, subtotal sin impuestos, descuento, IVA por tarifa y valor total.
 */
export function totalesNotaCredito(
  info: InfoNotaCreditoXml,
  detalles: DetalleNotaCreditoXml[],
): FilaTotal[] {
  const impuestos = lista(info.totalConImpuestos?.totalImpuesto);
  const ivas = impuestos.filter((i) => i.codigo === '2');
  const otros = impuestos.filter((i) => i.codigo !== '2');
  const etiqueta = (i: TotalImpuestoXml) =>
    TARIFA_IVA[i.codigoPorcentaje ?? ''] ?? `IVA (${i.codigoPorcentaje})`;

  const filas: FilaTotal[] = [];

  if (ivas.length === 0) {
    filas.push(['SUBTOTAL IVA 0%', monto(0), false]);
  }
  ivas.forEach((i) => {
    filas.push([`SUBTOTAL ${etiqueta(i)}`, monto(i.baseImponible), false]);
  });

  const descuento = detalles.reduce(
    (sum, d) => sum + (parseFloat(d.descuento ?? '') || 0),
    0,
  );
  filas.push(['SUBTOTAL SIN IMPUESTOS', monto(info.totalSinImpuestos), false]);
  filas.push(['TOTAL DESCUENTO', monto(descuento), false]);

  const ivasConValor = ivas.filter(
    (i) => !IVA_SIN_VALOR.includes(i.codigoPorcentaje ?? ''),
  );
  if (ivasConValor.length === 0) {
    filas.push(['IVA', monto(0), false]);
  }
  ivasConValor.forEach((i) => {
    filas.push([etiqueta(i), monto(i.valor), false]);
  });
  otros.forEach((i) => {
    const nombre = i.codigo === '3' ? 'ICE' : `IMPUESTO ${i.codigo}`;
    filas.push([nombre, monto(i.valor), false]);
  });

  filas.push(['VALOR TOTAL', monto(info.valorModificacion), true]);
  return filas;
}
