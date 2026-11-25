import { PDFPage, PDFPageDrawTextOptions } from 'pdf-lib';
import { RideGenerator } from './ride-generator';
import { XmlBuilderService } from '../services/xml-builder.service';
import {
  Ambiente,
  FormaPago,
  TipoComprobante,
  TipoEmision,
  TipoIdentificacion,
} from '../constants';
import { InfoTributaria } from '../interfaces';

/**
 * El RIDE (PDF) debe generarse para facturas y para notas de crédito.
 * Se capturan los textos dibujados para verificar el contenido.
 */
describe('RideGenerator', () => {
  const CLAVE_NC = '2411202604179001234500120010010000000071234567811';
  const CLAVE_FAC = '2011202601179001234500120010010000001231234567811';
  const builder = new XmlBuilderService();

  let textos: string[];
  let spy: jest.SpyInstance;

  beforeEach(() => {
    textos = [];
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = PDFPage.prototype.drawText;
    spy = jest
      .spyOn(PDFPage.prototype, 'drawText')
      .mockImplementation(function (
        this: PDFPage,
        text: string,
        opts?: PDFPageDrawTextOptions,
      ) {
        textos.push(text);
        original.call(this, text, opts);
      });
  });

  afterEach(() => spy.mockRestore());

  const infoTributaria = (
    clave: string,
    codDoc: TipoComprobante,
    sec: string,
  ): InfoTributaria => ({
    ambiente: Ambiente.PRODUCCION,
    tipoEmision: TipoEmision.NORMAL,
    razonSocial: 'EMISOR DE PRUEBA S.A.',
    nombreComercial: 'EMISOR',
    ruc: '1790012345001',
    claveAcceso: clave,
    codDoc,
    estab: '001',
    ptoEmi: '001',
    secuencial: sec,
    dirMatriz: 'Av. Amazonas y Colón, Quito',
  });

  /** Envuelve el comprobante como lo hace obtenerPdfAutorizado */
  const autorizado = (xml: string, clave: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>
<autorizacion>
  <estado>AUTORIZADO</estado>
  <numeroAutorizacion>${clave}</numeroAutorizacion>
  <fechaAutorizacion>24/11/2026 10:00:00</fechaAutorizacion>
  <comprobante><![CDATA[${xml}]]></comprobante>
</autorizacion>`;

  it('genera el RIDE de una nota de crédito', async () => {
    const xml = builder.buildNotaCredito({
      infoTributaria: infoTributaria(
        CLAVE_NC,
        TipoComprobante.NOTA_CREDITO,
        '000000007',
      ),
      infoNotaCredito: {
        fechaEmision: '24/11/2026',
        tipoIdentificacionComprador: TipoIdentificacion.CEDULA,
        razonSocialComprador: 'CLIENTE PRUEBA',
        identificacionComprador: '1710034065',
        obligadoContabilidad: 'NO',
        codDocModificado: '01',
        numDocModificado: '001-001-000000123',
        fechaEmisionDocSustento: '20/11/2026',
        totalSinImpuestos: 15,
        valorModificacion: 16.5,
        moneda: 'DOLAR',
        totalConImpuestos: [
          {
            codigo: '2',
            codigoPorcentaje: '4',
            tarifa: 15,
            baseImponible: 10,
            valor: 1.5,
          },
          {
            codigo: '2',
            codigoPorcentaje: '0',
            tarifa: 0,
            baseImponible: 5,
            valor: 0,
          },
        ],
        motivo: 'Devolución de mercadería',
      },
      detalles: [
        {
          codigoInterno: 'P001',
          descripcion: 'Producto gravado',
          cantidad: 1,
          precioUnitario: 10,
          descuento: 0,
          precioTotalSinImpuesto: 10,
          impuestos: [
            {
              codigo: '2',
              codigoPorcentaje: '4',
              tarifa: 15,
              baseImponible: 10,
              valor: 1.5,
            },
          ],
        },
        {
          codigoInterno: 'P002',
          descripcion: 'Producto tarifa 0',
          cantidad: 1,
          precioUnitario: 5,
          descuento: 0,
          precioTotalSinImpuesto: 5,
          impuestos: [
            {
              codigo: '2',
              codigoPorcentaje: '0',
              tarifa: 0,
              baseImponible: 5,
              valor: 0,
            },
          ],
        },
      ],
      infoAdicional: [{ nombre: 'direccion', valor: 'Calle Falsa 123' }],
    });

    const pdf = await RideGenerator.generateFromXml(autorizado(xml, CLAVE_NC));

    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(textos).toEqual(
      expect.arrayContaining([
        'NOTA DE CRÉDITO',
        'No. 001-001-000000007',
        CLAVE_NC,
        'CLIENTE PRUEBA',
        'Comprobante que se modifica:',
        'FACTURA 001-001-000000123',
        '20/11/2026',
        'Devolución de mercadería',
        'Calle Falsa 123',
        'P001',
        'P002',
        'SUBTOTAL IVA 15%',
        'SUBTOTAL IVA 0%',
        'IVA 15%',
        'VALOR TOTAL',
        '16.50',
      ]),
    );
    expect(textos).not.toContain('FORMA DE PAGO');
  });

  const facturaXml = (extra: Partial<InfoTributaria> = {}) =>
    builder.buildFactura({
      infoTributaria: {
        ...infoTributaria(CLAVE_FAC, TipoComprobante.FACTURA, '000000123'),
        ...extra,
      },
      infoFactura: {
        fechaEmision: '20/11/2026',
        obligadoContabilidad: 'NO',
        tipoIdentificacionComprador: TipoIdentificacion.CEDULA,
        razonSocialComprador: 'CLIENTE PRUEBA',
        identificacionComprador: '1710034065',
        direccionComprador: 'Calle Falsa 123',
        totalSinImpuestos: 10,
        totalDescuento: 0,
        totalConImpuestos: [
          {
            codigo: '2',
            codigoPorcentaje: '4',
            tarifa: 15,
            baseImponible: 10,
            valor: 1.5,
          },
        ],
        importeTotal: 11.5,
        moneda: 'DOLAR',
        pagos: [
          {
            formaPago: FormaPago.SIN_UTILIZACION_SISTEMA_FINANCIERO,
            total: 11.5,
          },
        ],
      },
      detalles: [
        {
          codigoPrincipal: 'P001',
          descripcion: 'Producto',
          cantidad: 1,
          precioUnitario: 10,
          descuento: 0,
          precioTotalSinImpuesto: 10,
          impuestos: [
            {
              codigo: '2',
              codigoPorcentaje: '4',
              tarifa: 15,
              baseImponible: 10,
              valor: 1.5,
            },
          ],
        },
      ],
    });

  it('sigue generando el RIDE de una factura', async () => {
    const xml = facturaXml();
    const pdf = await RideGenerator.generateFromXml(autorizado(xml, CLAVE_FAC));

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(textos).toEqual(
      expect.arrayContaining([
        'FACTURA',
        'No. 001-001-000000123',
        'SUBTOTAL IVA 15%',
        'VALOR TOTAL',
        '11.50',
        'FORMA DE PAGO',
        'EFECTIVO',
      ]),
    );
    expect(textos).not.toContain('Comprobante que se modifica:');
  });

  it.each([
    'CONTRIBUYENTE RÉGIMEN RIMPE',
    'CONTRIBUYENTE NEGOCIO POPULAR - RÉGIMEN RIMPE',
  ] as const)('imprime la leyenda RIMPE del XML: %s', async (leyenda) => {
    const xml = facturaXml({ contribuyenteRimpe: leyenda });
    await RideGenerator.generateFromXml(autorizado(xml, CLAVE_FAC));
    expect(textos).toContain(leyenda);
  });

  it('no imprime leyenda RIMPE si el emisor no es RIMPE', async () => {
    await RideGenerator.generateFromXml(autorizado(facturaXml(), CLAVE_FAC));
    expect(textos.some((t) => t.includes('RIMPE'))).toBe(false);
  });

  it('imprime agente de retención cuando viene en el XML', async () => {
    const xml = facturaXml({ agenteRetencion: '1' });
    await RideGenerator.generateFromXml(autorizado(xml, CLAVE_FAC));
    expect(textos).toContain('Agente de Retención Resolución No. 1');
  });
});
