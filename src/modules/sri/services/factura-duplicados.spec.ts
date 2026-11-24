import { FacturaService } from './factura.service';

/**
 * Una venta no debe recibir dos facturas autorizadas: si el sistema cliente
 * reintenta con la misma referencia externa, se reutiliza la factura previa
 * mientras esté autorizada o todavía pueda autorizarse.
 */
describe('FacturaService - facturas duplicadas por referencia externa', () => {
  const CLAVE_A = '1'.repeat(49);
  const CLAVE_B = '2'.repeat(49);

  function build(previas: any[], respuestasSri: Record<string, any> = {}) {
    const repository = {
      findComprobantesByReferenciaExterna: jest.fn().mockResolvedValue(previas),
      updateComprobante: jest.fn().mockResolvedValue({}),
    };
    const sriSoapClient = {
      autorizarComprobante: jest.fn(async (clave: string) => {
        const r = respuestasSri[clave];
        if (r instanceof Error) throw r;
        return r ?? { claveAccesoConsultada: clave, numeroComprobantes: '0' };
      }),
    };
    const service = new FacturaService(
      {} as any,
      {} as any,
      {} as any,
      sriSoapClient as any,
      repository as any,
      {} as any,
      {} as any,
      { emit: jest.fn() } as any,
    );
    const buscar = (ref: string) =>
      (service as any).buscarFacturaPrevia('emisor-1', ref);
    return { buscar, repository, sriSoapClient };
  }

  const autorizada = (clave: string) => ({
    claveAccesoConsultada: clave,
    numeroComprobantes: '1',
    autorizaciones: {
      autorizacion: [
        {
          estado: 'AUTORIZADO',
          numeroAutorizacion: clave,
          fechaAutorizacion: '2026-11-23T10:00:00',
          ambiente: 'PRODUCCIÓN',
        },
      ],
    },
  });

  it('sin facturas previas permite emitir', async () => {
    const { buscar } = build([]);
    await expect(buscar('venta:1')).resolves.toBeNull();
  });

  it('devuelve la factura ya autorizada sin consultar al SRI', async () => {
    const { buscar, sriSoapClient } = build([
      { id: 'c1', clave_acceso: CLAVE_A, estado: 'AUTORIZADO' },
    ]);
    const res = await buscar('venta:1');
    expect(res).toMatchObject({
      success: true,
      claveAcceso: CLAVE_A,
      estado: 'AUTORIZADO',
    });
    expect(sriSoapClient.autorizarComprobante).not.toHaveBeenCalled();
  });

  it('una PENDIENTE local que el SRI ya autorizó se actualiza y se devuelve', async () => {
    const { buscar, repository } = build(
      [{ id: 'c1', clave_acceso: CLAVE_A, estado: 'PENDIENTE' }],
      { [CLAVE_A]: autorizada(CLAVE_A) },
    );
    const res = await buscar('venta:1');
    expect(res).toMatchObject({
      success: true,
      claveAcceso: CLAVE_A,
      estado: 'AUTORIZADO',
    });
    expect(repository.updateComprobante).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ estado: 'AUTORIZADO' }),
    );
  });

  it('una PENDIENTE que el SRI aún no registra no permite emitir otra', async () => {
    const { buscar } = build([
      { id: 'c1', clave_acceso: CLAVE_A, estado: 'PENDIENTE' },
    ]);
    const res = await buscar('venta:1');
    expect(res).toMatchObject({
      success: false,
      claveAcceso: CLAVE_A,
      estado: 'PENDIENTE',
    });
  });

  it('si el SRI no responde, no se emite otra', async () => {
    const { buscar } = build(
      [{ id: 'c1', clave_acceso: CLAVE_A, estado: 'DEVUELTA' }],
      { [CLAVE_A]: new Error('timeout') },
    );
    const res = await buscar('venta:1');
    expect(res).toMatchObject({
      success: false,
      claveAcceso: CLAVE_A,
      estado: 'PENDIENTE',
    });
  });

  it('una EN PROCESO en el SRI no permite emitir otra', async () => {
    const { buscar } = build(
      [{ id: 'c1', clave_acceso: CLAVE_A, estado: 'DEVUELTA' }],
      {
        [CLAVE_A]: {
          autorizaciones: {
            autorizacion: [{ estado: 'EN PROCESO', ambiente: 'PRODUCCIÓN' }],
          },
        },
      },
    );
    const res = await buscar('venta:1');
    expect(res).toMatchObject({ success: false, claveAcceso: CLAVE_A });
  });

  it('una DEVUELTA que el SRI no registra permite emitir una nueva', async () => {
    const { buscar } = build([
      { id: 'c1', clave_acceso: CLAVE_A, estado: 'DEVUELTA' },
    ]);
    await expect(buscar('venta:1')).resolves.toBeNull();
  });

  it('revisa todas las previas: una NO AUTORIZADA no oculta otra autorizada', async () => {
    const { buscar } = build(
      [
        { id: 'c2', clave_acceso: CLAVE_B, estado: 'DEVUELTA' },
        { id: 'c1', clave_acceso: CLAVE_A, estado: 'PENDIENTE' },
      ],
      {
        [CLAVE_B]: {
          autorizaciones: {
            autorizacion: [{ estado: 'NO AUTORIZADO', ambiente: 'PRODUCCIÓN' }],
          },
        },
        [CLAVE_A]: autorizada(CLAVE_A),
      },
    );
    const res = await buscar('venta:1');
    expect(res).toMatchObject({ success: true, claveAcceso: CLAVE_A });
  });
});
