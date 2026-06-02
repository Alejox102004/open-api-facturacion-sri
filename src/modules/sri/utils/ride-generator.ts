import { PDFDocument, rgb, StandardFonts, PDFPage, PDFFont } from 'pdf-lib';
import { parseStringPromise } from 'xml2js';
import * as QRCode from 'qrcode';

// ─── Layout constants ────────────────────────────────────────────────────────
const M      = 30;               // left/right margin
const PAGE_W = 595;
const PAGE_H = 842;
const CW     = PAGE_W - M * 2;  // 535 usable width

const BLACK = rgb(0, 0, 0);
const WHITE = rgb(1, 1, 1);
const DGRAY = rgb(0.3, 0.3, 0.3);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function s(v: any): string { return String(v ?? ''); }

function fmt(v: any, d = 2): string {
  const n = parseFloat(s(v));
  return isNaN(n) ? '0.00' : n.toFixed(d);
}

function arr(v: any): any[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Fit text so it never exceeds maxPx at the given fontSize.
 * Appends '…' when truncated.
 */
function fit(text: string, font: PDFFont, size: number, maxPx: number): string {
  let t = s(text);
  if (font.widthOfTextAtSize(t, size) <= maxPx) return t;
  while (t.length > 1 && font.widthOfTextAtSize(t + '…', size) > maxPx) {
    t = t.slice(0, -1);
  }
  return t + '…';
}

/** Draw text clipped to maxW (guaranteed no overflow) */
function T(
  page: PDFPage, text: string,
  x: number, y: number, size: number, font: PDFFont,
  maxW: number, color = BLACK,
) {
  const t = fit(s(text), font, size, maxW);
  if (!t || t === '…') return;
  page.drawText(t, { x, y, size, font, color });
}

/** Draw text right-aligned within a cell of width w starting at x */
function TR(
  page: PDFPage, text: string,
  x: number, y: number, w: number, size: number, font: PDFFont,
  color = BLACK,
) {
  const t  = fit(s(text), font, size, w - 2);
  const tw = font.widthOfTextAtSize(t, size);
  page.drawText(t, { x: x + w - tw - 2, y, size, font, color });
}

/** Draw text centered within width w starting at x */
function TC(
  page: PDFPage, text: string,
  x: number, y: number, w: number, size: number, font: PDFFont,
  color = BLACK,
) {
  const t  = fit(s(text), font, size, w - 4);
  const tw = font.widthOfTextAtSize(t, size);
  page.drawText(t, { x: x + (w - tw) / 2, y, size, font, color });
}

/** Horizontal line */
function HL(page: PDFPage, x: number, y: number, w: number, thick = 0.5) {
  page.drawLine({ start: { x, y }, end: { x: x + w, y }, thickness: thick, color: BLACK });
}

/** Vertical line */
function VL(page: PDFPage, x: number, y: number, h: number, thick = 0.5) {
  page.drawLine({ start: { x, y }, end: { x, y: y - h }, thickness: thick, color: BLACK });
}

/** Rectangle with black border, white fill */
function BOX(page: PDFPage, x: number, y: number, w: number, h: number, thick = 0.5) {
  page.drawRectangle({
    x, y: y - h, width: w, height: h,
    color: WHITE, borderColor: BLACK, borderWidth: thick,
  });
}

// ─── Main class ───────────────────────────────────────────────────────────────
export class RideGenerator {

  static async generateFromXml(xml: string, logoBuffer?: Buffer): Promise<Buffer> {

    // ── Parse XML ──────────────────────────────────────────────────────────────
    const result: any = await parseStringPromise(xml, { explicitArray: false });

    let auth      = result.autorizacion;
    let comp      = result;

    if (auth) {
      const raw = auth.comprobante;
      comp = typeof raw === 'string'
        ? await parseStringPromise(raw, { explicitArray: false })
        : raw;
    } else {
      const rk = Object.keys(comp)[0];
      auth = {
        numeroAutorizacion: comp[rk]?.infoTributaria?.claveAcceso ?? 'PENDIENTE',
        fechaAutorizacion:  'Consultar portal SRI',
      };
    }

    let tipo      = 'FACTURA';
    let info: any = {};
    let it: any   = {};
    let detalles: any[] = [];
    let adicional: any[] = [];

    if (comp.factura) {
      info      = comp.factura.infoFactura         ?? {};
      it        = comp.factura.infoTributaria       ?? {};
      detalles  = arr(comp.factura.detalles?.detalle);
      adicional = arr(comp.factura.infoAdicional?.campoAdicional);
    } else {
      const rk = Object.keys(comp)[0];
      if (rk) {
        tipo = rk.replace(/([A-Z])/g, ' $1').toUpperCase().trim();
        it   = comp[rk].infoTributaria ?? {};
        const ik = `info${rk[0].toUpperCase()}${rk.slice(1)}`;
        info = comp[rk][ik] ?? {};
      }
    }

    // ── IVA analysis ──────────────────────────────────────────────────────────
    const impuestos = arr(info.totalConImpuestos?.totalImpuesto);
    const ivaRow    = impuestos.find((i: any) => String(i.codigoPorcentaje) === '7' || String(i.codigoPorcentaje) === '4' || String(i.codigoPorcentaje) === '2');
    const iva0Row   = impuestos.find((i: any) => String(i.codigoPorcentaje) === '0');
    const ivaLabel  = String(ivaRow?.codigoPorcentaje) === '2' ? '12%' : '15%';
    const ivaBase   = ivaRow?.baseImponible ?? '0.00';
    const ivaValor  = ivaRow?.valor         ?? '0.00';
    const sub0Base  = iva0Row?.baseImponible ?? info.totalSinImpuestos ?? '0.00';

    // ── PDF setup ─────────────────────────────────────────────────────────────
    const pdfDoc = await PDFDocument.create();
    pdfDoc.setTitle(`RIDE ${tipo} ${s(it.ruc)}`);
    pdfDoc.setAuthor('Sistema Facturación Electrónica');

    const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const mono = await pdfDoc.embedFont(StandardFonts.CourierBold);

    let Y = PAGE_H - M;

    // ══════════════════════════════════════════════════════════════════════════
    // § 1  HEADER: Logo (izq) | Info Tributaria (der) — LOGO GRANDE Y RUC ABAJO
    // ══════════════════════════════════════════════════════════════════════════
    {
      const H  = 185;            // Se aumentó a 185 para dar espacio al logo más grande
      const LW = CW * 0.44;      // 235 (Ancho bloque izquierdo)
      const RW = CW - LW - 6;    // 294 (Ancho bloque derecho)

      // ── LEFT BLOCK: Logo & Emisor ──────────────────────────────────────────
      BOX(page, M, Y, LW, H);
      const logoY = Y - 70;
      let logoDrawn = false;

      if (logoBuffer && logoBuffer.length > 0) {
        try {
          const isPng = logoBuffer[0] === 0x89 && logoBuffer[1] === 0x50;
          const logoImage = isPng ? await pdfDoc.embedPng(logoBuffer) : await pdfDoc.embedJpg(logoBuffer);

          const maxW = LW - 16;
          const maxH = 70; // SE DUPLICÓ EL ALTO MÁXIMO (Antes 35) para que el logo sea más grande
          let w = logoImage.width;
          let h = logoImage.height;

          const scale = Math.min(maxW / w, maxH / h);
          w = w * scale;
          h = h * scale;

          const logoX = M + 8 + (maxW - w) / 2;
          const logoDrawY = Y - 8 - h - (maxH - h) / 2;

          page.drawImage(logoImage, { x: logoX, y: logoDrawY, width: w, height: h });
          logoDrawn = true;
        } catch (logoErr) {
          console.error('Error embedding logo in RIDE:', logoErr);
        }
      }

      if (!logoDrawn) {
        page.drawText('TU LOGO', { x: M + 20, y: Y - 40, size: 18, font: bold, color: rgb(0.8, 0.8, 0.8) });
      }

      // Textos del emisor (ajustados hacia abajo para no colisionar con el logo grande)
      let yl = Y - 92;
      T(page, it.razonSocial, M + 8, yl, 8.5, bold, LW - 16);
      yl -= 11;
      T(page, it.nombreComercial ?? '', M + 8, yl, 7.5, font, LW - 16);
      yl -= 14;
      T(page, 'Dirección Matriz:', M + 8, yl, 7, bold, 80);
      yl -= 10;
      T(page, it.dirMatriz, M + 8, yl, 7, font, LW - 16);
      yl -= 15;
      T(page, 'Obligado a llevar contabilidad:', M + 8, yl, 7, bold, 120);
      T(page, info.obligadoContabilidad ?? 'NO', M + 130, yl, 7, font, 20);


      // ── RIGHT BLOCK: SRI Info ──────────────────────────────────────────────
      BOX(page, M + LW + 6, Y, RW, H);
      let yr = Y - 16;
      
      // 1. Banner Tipo Documento (FACTURA va arriba de todo)
      page.drawRectangle({ x: M + LW + 6, y: yr - 4, width: RW, height: 18, color: rgb(0.1, 0.3, 0.6) });
      TC(page, tipo, M + LW + 6, yr, RW, 10, bold, WHITE);

      // 2. Secuencial (No. Factura justo abajo del banner)
      yr -= 24;
      T(page, `No. ${it.estab}-${it.ptoEmi}-${it.secuencial}`, M + LW + 14, yr, 11, bold, RW - 28);

      // 3. R.U.C. (Ahora se posiciona debajo de la factura)
      yr -= 20;
      T(page, `R.U.C.:`, M + LW + 14, yr, 10, bold, 45);
      T(page, it.ruc, M + LW + 55, yr, 10, font, 150);

      // 4. Número de Autorización
      yr -= 20;
      T(page, 'NÚMERO DE AUTORIZACIÓN:', M + LW + 14, yr, 7, bold, RW - 28);
      yr -= 9;
      T(page, auth.numeroAutorizacion, M + LW + 14, yr, 7, font, RW - 28);

      // 5. Detalles adicionales del SRI
      yr -= 16;
      T(page, 'FECHA Y HORA DE AUTORIZACIÓN:', M + LW + 14, yr, 7, bold, 140);
      T(page, auth.fechaAutorizacion, M + LW + 155, yr, 7, font, 120);

      yr -= 12;
      T(page, 'AMBIENTE:', M + LW + 14, yr, 7, bold, 50);
      T(page, it.ambiente === '1' ? 'PRUEBAS' : 'PRODUCCIÓN', M + LW + 65, yr, 7, font, 80);

      yr -= 11;
      T(page, 'EMISIÓN:', M + LW + 14, yr, 7, bold, 50);
      T(page, it.tipoEmision === '1' ? 'NORMAL' : 'CONTINGENCIA', M + LW + 65, yr, 7, font, 80);

      // Desplazamiento global
      Y -= H + 10; 
    }
// ══════════════════════════════════════════════════════════════════════════
    // § 2  CLAVE DE ACCESO & QR (Rediseñado y Estilizado)
    // ══════════════════════════════════════════════════════════════════════════
    {
      const BH = 65; // Altura del bloque un poco más compacta y limpia
      BOX(page, M, Y, CW, BH);

      const claveKey = s(it.claveAcceso ?? auth.numeroAutorizacion);

      // ── Generar QR Real (Derecha) ──
      if (claveKey && claveKey !== 'PENDIENTE') {
        try {
          const qrBuffer = await QRCode.toBuffer(claveKey, { margin: 1, width: 200 });
          const qrImage  = await pdfDoc.embedPng(qrBuffer);
          const qrSize   = 55; // Reducido ligeramente para dar mejor margen interno
          page.drawImage(qrImage, {
            x: M + CW - qrSize - 10,
            y: Y - BH + 5,
            width: qrSize,
            height: qrSize
          });
        } catch (e) {
          console.error('Error generating QR:', e);
        }
      }

      // Título del Bloque
      T(page, 'CLAVE DE ACCESO', M + 12, Y - 12, 8, bold, 120);

      // ── Código de Barras Estilizado (Izquierda) ──
      const barY = Y - 20; // Punto de inicio superior de las barras
      const barX = M + 12; // Margen izquierdo alineado con el título
      const barH = 26;     // Altura fija de las barras para que no pisen el texto
      
      // Usamos la propia clave de acceso para variar los grosores de forma pseudo-real
      for (let i = 0; i < claveKey.length; i++) {
        const digit = parseInt(claveKey[i]) || 0;
        
        // Determinamos grosores basados en el dígito de la clave para simular un código real
        const thick1 = (digit % 2 === 0) ? 1.5 : 0.6;
        const thick2 = (digit % 3 === 0) ? 1.8 : 0.9;
        
        // Línea 1 del par
        page.drawLine({
          start: { x: barX + (i * 5), y: barY },
          end: { x: barX + (i * 5), y: barY - barH },
          thickness: thick1,
          color: BLACK
        });

        // Línea 2 del par (crea el efecto de código de barras denso)
        page.drawLine({
          start: { x: barX + (i * 5) + 2, y: barY },
          end: { x: barX + (i * 5) + 2, y: barY - barH },
          thickness: thick2,
          color: BLACK
        });
      }

      // ── Clave en texto legible (Ubicada abajo con suficiente separación) ──
      const textY = Y - 56; // Bajado lo suficiente para que no choque con las barras
      T(page, claveKey, M + 12, textY, 7.5, mono, CW - 80);

      Y -= BH + 10;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // § 3  DATOS DEL RECEPTOR
    // ══════════════════════════════════════════════════════════════════════════
    {
      const BH = 55;
      BOX(page, M, Y, CW, BH);

      let yr = Y - 15;
      T(page, 'Razón Social / Nombres y Apellidos:', M + 8, yr, 8, bold, 160);
      T(page, info.razonSocialComprador, M + 175, yr, 8, font, CW - 185);

      yr -= 14;
      T(page, 'Identificación:', M + 8, yr, 8, bold, 80);
      T(page, info.identificacionComprador, M + 85, yr, 8, font, 100);
      T(page, 'Fecha Emisión:', M + 220, yr, 8, bold, 80);
      T(page, info.fechaEmision, M + 305, yr, 8, font, 80);

      yr -= 14;
      T(page, 'Dirección:', M + 8, yr, 8, bold, 60);
      T(page, info.direccionComprador ?? 'S/N', M + 85, yr, 8, font, CW - 100);

      Y -= BH + 10;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // § 4  TABLA DE DETALLES
    // ══════════════════════════════════════════════════════════════════════════
    {
      const HH = 18;  // header height
      const RH = 16;  // row height

      // Col definitions
      const cols = [
        { l: 'Cód. Principal', w: 70,  a: 'l' },
        { l: 'Cant',            w: 40,  a: 'r' },
        { l: 'Descripción',     w: 220, a: 'l' },
        { l: 'P. Unitario',     w: 65,  a: 'r' },
        { l: 'Desc.',           w: 55,  a: 'r' },
        { l: 'Total',           w: 85,  a: 'r' },
      ];

      let cx = M;
      BOX(page, M, Y, CW, HH);
      page.drawRectangle({ x: M, y: Y - HH, width: CW, height: HH, color: rgb(0.95, 0.95, 0.95) });

      cols.forEach(c => {
        if (c.a === 'r') TR(page, c.l, cx, Y - HH + 5, c.w, 7, bold);
        else T(page, c.l, cx + 4, Y - HH + 5, 7, bold, c.w - 8);
        cx += c.w;
        if (cx < M + CW) VL(page, cx, Y, HH, 0.3);
      });

      Y -= HH;

      detalles.forEach(d => {
        if (Y < 180) return; // Basic page break safety
        BOX(page, M, Y, CW, RH);
        cx = M;
        const vals = [
          s(d.codigoPrincipal),
          fmt(d.cantidad),
          s(d.descripcion),
          fmt(d.precioUnitario),
          fmt(d.descuento),
          fmt(d.precioTotalSinImpuesto)
        ];
        cols.forEach((c, i) => {
          if (c.a === 'r') TR(page, vals[i], cx, Y - RH + 5, c.w, 7, font);
          else T(page, vals[i], cx + 4, Y - RH + 5, 7, font, c.w - 8);
          cx += c.w;
          if (cx < M + CW) VL(page, cx, Y, RH, 0.3);
        });
        Y -= RH;
      });

      HL(page, M, Y, CW, 0.8);
      Y -= 4;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // § 5  FOOTER — Info Adicional (izq) | Totales (der)
    // ══════════════════════════════════════════════════════════════════════════
    {
      const TOT_W  = 196;        // totales column width
      const ADD_W  = CW - TOT_W - 2;
      const TOT_X  = M + ADD_W + 2;
      const ROW_H  = 13;

      // ── RESUMEN ─────────────────────────────────────────────────────────────
      const totalRows: [string, string, boolean][] = [
        [`SUBTOTAL IVA 0%`,              fmt(sub0Base),               false],
        [`SUBTOTAL IVA ${ivaLabel}`,     fmt(ivaBase),                false],
        [`SUBTOTAL SIN IMPUESTOS`,       fmt(info.totalSinImpuestos ?? sub0Base), false],
        [`TOTAL DESCUENTO`,              fmt(info.totalDescuento ?? 0), false],
        [`IVA ${ivaLabel}`,              fmt(ivaValor),               false],
        [`VALOR TOTAL`,                  fmt(info.importeTotal),       true ],
      ];

      const LVAL_X  = TOT_X;
      const LVAL_W  = TOT_W - 55;  // label cell
      const RVAL_X  = TOT_X + LVAL_W;
      const RVAL_W  = 55;           // value cell

      let yt = Y;

      // Header
      BOX(page, TOT_X, yt, TOT_W, ROW_H);
      TC(page, 'RESUMEN', TOT_X, yt - ROW_H + 4, TOT_W, 7, bold);
      yt -= ROW_H;

      totalRows.forEach(([label, val, isBold]) => {
        const f = isBold ? bold : font;
        BOX(page, LVAL_X, yt, LVAL_W, ROW_H);
        BOX(page, RVAL_X, yt, RVAL_W, ROW_H);
        T(page, label, LVAL_X + 3, yt - ROW_H + 4, 6, f, LVAL_W - 5);
        TR(page, val,  RVAL_X + 2, yt - ROW_H + 4, RVAL_W - 3, 6.5, f);
        yt -= ROW_H;
      });

      // ── FORMA DE PAGO ────────────────────────────────────────────────────────
      yt -= 2;
      BOX(page, TOT_X, yt, TOT_W, ROW_H);
      TC(page, 'FORMA DE PAGO', TOT_X, yt - ROW_H + 4, TOT_W, 7, bold);
      yt -= ROW_H;

      const pagos = arr(info.pagos?.pago);
      const FP_MAP: Record<string,string> = { '01':'EFECTIVO','16':'DEBITO','19':'CREDITO','20':'OTROS' };

      pagos.forEach(p => {
        BOX(page, LVAL_X, yt, LVAL_W, ROW_H);
        BOX(page, RVAL_X, yt, RVAL_W, ROW_H);
        T(page, FP_MAP[p.formaPago] ?? 'S. FINANCIERO', LVAL_X + 3, yt - ROW_H + 4, 6, font, LVAL_W - 5);
        TR(page, fmt(p.total), RVAL_X + 2, yt - ROW_H + 4, RVAL_W - 3, 6.5, font);
        yt -= ROW_H;
      });

      // ── INFO ADICIONAL ──────────────────────────────────────────────────────
      let ya = Y;
      BOX(page, M, ya, ADD_W, ROW_H);
      TC(page, 'INFORMACIÓN ADICIONAL', M, ya - ROW_H + 4, ADD_W, 7, bold);
      ya -= ROW_H;

      adicional.slice(0, 10).forEach(a => {
        BOX(page, M, ya, ADD_W, ROW_H);
        const label = s(a.$?.nombre ?? 'Dato');
        const val   = s(a._ ?? a);
        T(page, `${label}:`, M + 4, ya - ROW_H + 4, 6, bold, 80);
        T(page, val, M + 85, ya - ROW_H + 4, 6, font, ADD_W - 90);
        ya -= ROW_H;
      });
    }

    const pdfBytes = await pdfDoc.save();
    return Buffer.from(pdfBytes);
  }
}