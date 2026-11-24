import { SriService } from './sri.service';

/**
 * El backend usa /sri/verificar para saber si una factura ya fue autorizada.
 * Si el SRI la autorizó y aquí seguía PENDIENTE, el RIDE (PDF) no se podía
 * generar porque faltaba el XML autorizado. La verificación debe guardarlo.
 */
describe('SriService.verificarEnSri - guarda la autorización', () => {
  // RUC 0401932181001 en las posiciones 11-23 de la clave.
  const CLAVE = '2411202601' + '0401932181001' + '1' + '001001' + '000001217' + '72219773' + '1' + '3';

  function build(estadoLocal: string | null, respuestaSri: any) {
    const repository = {
      findComprobanteByClaveAcceso: jest.fn().mockResolvedValue(
        estadoLocal
          ? {
              id: 'c1',
              clave_acceso: CLAVE,
              estado: estadoLocal,
              fecha_emision: '2026-11-24',
              emisor_id: 'e1',
              tipo_comprobante: '01',
              secuencial: '000001217',
            }
          : null,
      ),
      updateComprobante: jest.fn().mockResolvedValue({}),
      saveXml: jest.fn().mockResolvedValue({}),
    };
    const xmlStorage = { saveXml: jest.fn().mockReturnValue('/xml/autorizado.xml') };
    const events = { emit: jest.fn() };
    const soap = { autorizarComprobante: jest.fn().mockResolvedValue(respuestaSri) };
    const service = new SriService(
      soap as any,
      repository as any,
      xmlStorage as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      events as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { service, repository, xmlStorage, events };
  }

  const autorizado = {
    autorizaciones: {
      autorizacion: {
        estado: 'AUTORIZADO',
        numeroAutorizacion: CLAVE,
        fechaAutorizacion: '2026-11-24T18:30:00-05:00',
        comprobante: '<factura/>',
      },
    },
  };

  it('PENDIENTE local + AUTORIZADO en el SRI: guarda estado y XML', async () => {
    const { service, repository, xmlStorage, events } = build('PENDIENTE', autorizado);
    const res = await service.verificarEnSri(CLAVE);

    expect(repository.updateComprobante).toHaveBeenCalledWith('c1', expect.objectContaining({
      estado: 'AUTORIZADO',
      numero_autorizacion: CLAVE,
    }));
    expect(xmlStorage.saveXml).toHaveBeenCalledWith(
      '0401932181001', CLAVE, expect.any(Date), 'autorizado', '<factura/>',
    );
    expect(repository.saveXml).toHaveBeenCalledWith({
      comprobante_id: 'c1',
      xml_autorizado_path: '/xml/autorizado.xml',
    });
    expect(events.emit).toHaveBeenCalledWith('comprobante.autorizado', expect.anything());
    expect(res).toMatchObject({ estado: 'AUTORIZADO', estadoLocal: 'AUTORIZADO', sincronizado: true });
  });

  it('ya AUTORIZADO local: no escribe nada', async () => {
    const { service, repository } = build('AUTORIZADO', autorizado);
    await service.verificarEnSri(CLAVE);
    expect(repository.updateComprobante).not.toHaveBeenCalled();
  });

  it('el SRI aún no lo registra: no escribe nada', async () => {
    const { service, repository } = build('PENDIENTE', { numeroComprobantes: '0' });
    const res = await service.verificarEnSri(CLAVE);
    expect(repository.updateComprobante).not.toHaveBeenCalled();
    expect(res).toMatchObject({ existeEnSri: false, sincronizado: false });
  });

  it('ANULADO local no se revive', async () => {
    const { service, repository } = build('ANULADO', autorizado);
    await service.verificarEnSri(CLAVE);
    expect(repository.updateComprobante).not.toHaveBeenCalled();
  });
});
