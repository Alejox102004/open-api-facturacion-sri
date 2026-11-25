import { BadRequestException } from '@nestjs/common';
import { NotaCreditoService } from './nota-credito.service';
import { CreateNotaCreditoDto } from '../dto';
import { TipoComprobante } from '../constants';

/**
 * Una devolución no debe recibir dos notas de crédito autorizadas: si el
 * sistema cliente reintenta con la misma referencia externa se reutiliza la
 * nota previa; si el SRI no responde, la nota queda PENDIENTE con su clave; y
 * la suma de notas no puede superar el total de la factura original.
 */
describe('NotaCreditoService - emisión segura', () => {
  const CLAVE_PREVIA = '1'.repeat(49);
  const CLAVE_NUEVA = '2'.repeat(49);

  function dto(
    extra: Partial<CreateNotaCreditoDto> = {},
  ): CreateNotaCreditoDto {
    return {
      ambiente: '2',
      fechaEmision: '24/11/2026',
      emisor: {
        ruc: '1790012345001',
        razonSocial: 'EMISOR DE PRUEBA S.A.',
        dirMatriz: 'Quito',
        establecimiento: '001',
        puntoEmision: '001',
        obligadoContabilidad: 'NO',
      },
      comprador: {
        tipoIdentificacion: '05',
        identificacion: '1710034065',
        razonSocial: 'CLIENTE PRUEBA',
        email: 'cliente@example.com',
      },
      codDocModificado: '01',
      numDocModificado: '001-001-000000123',
      fechaEmisionDocSustento: '20/11/2026',
      motivo: 'Devolución de mercadería',
      detalles: [
        {
          codigoPrincipal: 'P001',
          descripcion: 'Producto',
          cantidad: 1,
          precioUnitario: 10,
          descuento: 0,
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
      ...extra,
    } as CreateNotaCreditoDto;
  }

  function build(
    opts: {
      previas?: any[];
      factura?: any;
      yaEmitido?: string;
      enviar?: () => Promise<any>;
    } = {},
  ) {
    const repository = {
      findEmisorByRuc: jest.fn().mockResolvedValue({
        id: 'emisor-1',
        certificado_nombre: 'cert.p12',
        certificado_password_encrypted: 'xxx',
      }),
      findPuntoEmision: jest
        .fn()
        .mockResolvedValue({ punto_emision_id: 'pe-1' }),
      findComprobantesByReferenciaExterna: jest
        .fn()
        .mockResolvedValue(opts.previas ?? []),
      updateComprobante: jest.fn().mockResolvedValue({}),
      findFacturaPorNumero: jest.fn().mockResolvedValue(opts.factura ?? null),
      sumarNotasCreditoPorDocModificado: jest
        .fn()
        .mockResolvedValue(opts.yaEmitido ?? '0'),
      executeInTransaction: jest.fn((fn: (client: unknown) => unknown) =>
        Promise.resolve(fn({})),
      ),
      getNextSecuencial: jest.fn().mockResolvedValue('000000007'),
      createComprobante: jest.fn().mockResolvedValue({ id: 'nc-1' }),
      createDetalles: jest.fn().mockResolvedValue([{ id: 'det-1' }]),
      createImpuestos: jest.fn().mockResolvedValue([]),
      createTotales: jest.fn().mockResolvedValue([]),
      saveXml: jest.fn().mockResolvedValue({}),
      createInfoAdicional: jest.fn().mockResolvedValue([]),
    };
    const sriSoapClient = {
      autorizarComprobante: jest.fn().mockResolvedValue({
        claveAccesoConsultada: CLAVE_PREVIA,
        numeroComprobantes: '0',
      }),
      enviarYAutorizar: jest.fn(
        opts.enviar ??
          (() =>
            Promise.resolve({
              success: true,
              claveAcceso: CLAVE_NUEVA,
              estado: 'AUTORIZADO',
              numeroAutorizacion: CLAVE_NUEVA,
              fechaAutorizacion: '2026-11-24T10:00:00',
              xmlAutorizado: '<autorizado/>',
              mensajes: [],
            })),
      ),
    };
    const xmlStorage = {
      saveAllXmls: jest.fn().mockReturnValue({
        firmadoPath: 'firmados/nc.xml',
        autorizadoPath: undefined,
      }),
    };
    const base = {
      validarIdentificacion: jest.fn(),
      validarTipoIdentificacionCatalogo: jest.fn().mockResolvedValue(undefined),
      validarImpuestosDetalles: jest.fn().mockResolvedValue(undefined),
      validarDocumentoSustentoCatalogo: jest.fn().mockResolvedValue(undefined),
      getDefaultAmbiente: jest.fn().mockReturnValue('2'),
    };
    const service = new NotaCreditoService(
      { generate: jest.fn().mockReturnValue(CLAVE_NUEVA) } as never,
      {
        buildNotaCredito: jest.fn().mockReturnValue('<notaCredito/>'),
      } as never,
      {
        signXmlForEmisor: jest.fn().mockResolvedValue('<notaCredito firmada/>'),
      } as never,
      sriSoapClient as never,
      repository as never,
      xmlStorage as never,
      base as never,
      { emit: jest.fn() } as never,
    );
    return { service, repository, sriSoapClient, xmlStorage };
  }

  describe('reintento con la misma referencia externa', () => {
    it('devuelve la nota de crédito ya autorizada y no reserva secuencial', async () => {
      const { service, repository, sriSoapClient } = build({
        previas: [
          {
            id: 'nc-0',
            clave_acceso: CLAVE_PREVIA,
            estado: 'AUTORIZADO',
            numero_autorizacion: CLAVE_PREVIA,
          },
        ],
      });

      const res = await service.emitirNotaCredito(
        dto({ referenciaExterna: 'devolucion:55' }),
      );

      expect(res).toMatchObject({
        success: true,
        claveAcceso: CLAVE_PREVIA,
        estado: 'AUTORIZADO',
      });
      expect(res.mensajes).toEqual([
        expect.objectContaining({ identificador: 'NOTA_CREDITO_EXISTENTE' }),
      ]);
      expect(
        repository.findComprobantesByReferenciaExterna,
      ).toHaveBeenCalledWith(
        'emisor-1',
        TipoComprobante.NOTA_CREDITO,
        'devolucion:55',
      );
      expect(repository.getNextSecuencial).not.toHaveBeenCalled();
      expect(sriSoapClient.enviarYAutorizar).not.toHaveBeenCalled();
      expect(repository.createComprobante).not.toHaveBeenCalled();
    });

    it('una previa PENDIENTE que el SRI aún no registra no permite emitir otra', async () => {
      const { service, repository } = build({
        previas: [
          { id: 'nc-0', clave_acceso: CLAVE_PREVIA, estado: 'PENDIENTE' },
        ],
      });

      const res = await service.emitirNotaCredito(
        dto({ referenciaExterna: 'devolucion:55' }),
      );

      expect(res).toMatchObject({
        success: false,
        claveAcceso: CLAVE_PREVIA,
        estado: 'PENDIENTE',
      });
      expect(res.mensajes).toEqual([
        expect.objectContaining({
          identificador: 'NOTA_CREDITO_EXISTENTE_PENDIENTE',
        }),
      ]);
      expect(repository.getNextSecuencial).not.toHaveBeenCalled();
    });

    it('sin previas emite una nueva y guarda la referencia externa', async () => {
      const { service, repository } = build();

      const res = await service.emitirNotaCredito(
        dto({ referenciaExterna: 'devolucion:55' }),
      );

      expect(res).toMatchObject({ success: true, claveAcceso: CLAVE_NUEVA });
      expect(repository.getNextSecuencial).toHaveBeenCalledTimes(1);
      // El secuencial se reserva dentro de una transacción
      expect(repository.getNextSecuencial).toHaveBeenCalledWith(
        'pe-1',
        TipoComprobante.NOTA_CREDITO,
        expect.anything(),
      );
      expect(repository.createComprobante).toHaveBeenCalledWith(
        expect.objectContaining({
          tipo_comprobante: TipoComprobante.NOTA_CREDITO,
          id_referencia_externa: 'devolucion:55',
          estado: 'AUTORIZADO',
        }),
        expect.anything(),
      );
    });
  });

  describe('el SRI no responde', () => {
    it('guarda la nota como PENDIENTE con el XML firmado y devuelve su clave', async () => {
      const { service, repository, xmlStorage } = build({
        enviar: () => Promise.reject(new Error('ETIMEDOUT')),
      });

      const res = await service.emitirNotaCredito(
        dto({ referenciaExterna: 'devolucion:56' }),
      );

      expect(res).toMatchObject({
        success: false,
        claveAcceso: CLAVE_NUEVA,
        estado: 'PENDIENTE',
      });
      expect(res.mensajes).toEqual([
        expect.objectContaining({ identificador: 'SRI_TIMEOUT' }),
      ]);
      expect(repository.createComprobante).toHaveBeenCalledWith(
        expect.objectContaining({
          clave_acceso: CLAVE_NUEVA,
          estado: 'PENDIENTE',
          id_referencia_externa: 'devolucion:56',
          doc_modificado_numero: '001-001-000000123',
        }),
        expect.anything(),
      );
      // El XML firmado se guarda para poder reintentar la misma clave
      expect(xmlStorage.saveAllXmls).toHaveBeenCalledWith(
        '1790012345001',
        CLAVE_NUEVA,
        expect.any(Date),
        undefined,
        '<notaCredito firmada/>',
        undefined,
      );
      expect(repository.saveXml).toHaveBeenCalledWith(
        expect.objectContaining({ xml_firmado_path: 'firmados/nc.xml' }),
        expect.anything(),
      );
    });
  });

  describe('total contra la factura original', () => {
    it('rechaza si la nota más las ya emitidas supera el total de la factura', async () => {
      const { service, repository } = build({
        factura: { id: 'f-1', importe_total: '20.00', estado: 'AUTORIZADO' },
        yaEmitido: '10.00',
      });

      // Esta nota es de 11.50 y solo quedan 10.00 disponibles
      const promesa = service.emitirNotaCredito(dto());
      await expect(promesa).rejects.toBeInstanceOf(BadRequestException);
      await expect(promesa).rejects.toThrow(/saldo disponible \$10\.00/);
      expect(repository.findFacturaPorNumero).toHaveBeenCalledWith(
        'emisor-1',
        '2',
        '001-001-000000123',
      );
      expect(repository.getNextSecuencial).not.toHaveBeenCalled();
    });

    it('permite la nota si cabe exactamente en el saldo', async () => {
      const { service, repository } = build({
        factura: { id: 'f-1', importe_total: '21.50', estado: 'AUTORIZADO' },
        yaEmitido: '10.00',
      });

      await expect(service.emitirNotaCredito(dto())).resolves.toMatchObject({
        success: true,
      });
      expect(repository.getNextSecuencial).toHaveBeenCalledTimes(1);
    });

    it('si la factura no está en la base no se valida el total', async () => {
      const { service, repository } = build({ factura: null });

      await expect(service.emitirNotaCredito(dto())).resolves.toMatchObject({
        success: true,
      });
      expect(
        repository.sumarNotasCreditoPorDocModificado,
      ).not.toHaveBeenCalled();
    });
  });
});
