import { BadRequestException } from '@nestjs/common';
import { PuntosEmisionService } from './puntos-emision.service';

/**
 * updateSecuencial no debe permitir retroceder el contador por debajo de un
 * comprobante ya emitido: la siguiente factura saldría con número repetido.
 */
describe('PuntosEmisionService.updateSecuencial', () => {
  const punto = {
    id: 'pe-1',
    emisor_id: 'em-1',
    establecimiento_id: 'est-1',
    establecimiento: '001',
    punto_emision: '001',
    direccion: 'x',
    descripcion: null,
    estado: 'ACTIVO',
    created_at: new Date(),
  };

  function makeService(maxEmitido: string | null) {
    const updates: unknown[][] = [];
    const db = {
      query: jest.fn(async (sql: string, params: unknown[]) => {
        if (sql.includes('FROM puntos_emision pe')) return { rows: [punto] };
        if (sql.includes('SELECT tipo_comprobante, ultimo_secuencial')) {
          return {
            rows: [{ tipo_comprobante: '01', ultimo_secuencial: '10' }],
          };
        }
        if (sql.includes('MAX(secuencial::bigint)')) {
          return { rows: [{ max_secuencial: maxEmitido }] };
        }
        if (sql.includes('UPDATE secuenciales')) {
          updates.push(params);
          return {
            rows: [
              {
                id: 's-1',
                punto_emision_id: 'pe-1',
                tipo_comprobante: '01',
                ultimo_secuencial: String(params[0]),
                updated_at: new Date(),
              },
            ],
          };
        }
        throw new Error(`consulta inesperada: ${sql}`);
      }),
    };
    return { service: new PuntosEmisionService(db as any), updates };
  }

  it('permite fijar el secuencial inicial cuando no hay comprobantes', async () => {
    const { service, updates } = makeService(null);
    const res = await service.updateSecuencial('em-1', 'pe-1', '01', {
      ultimoSecuencial: 1212,
    });
    expect(res.ultimoSecuencial).toBe(1212);
    expect(res.proximoSecuencial).toBe(1213);
    expect(updates).toHaveLength(1);
  });

  it('permite subir o igualar el último emitido', async () => {
    const { service, updates } = makeService('1214');
    await service.updateSecuencial('em-1', 'pe-1', '01', {
      ultimoSecuencial: 1214,
    });
    await service.updateSecuencial('em-1', 'pe-1', '01', {
      ultimoSecuencial: 1500,
    });
    expect(updates).toHaveLength(2);
  });

  it('rechaza bajar por debajo de un comprobante ya emitido', async () => {
    const { service, updates } = makeService('1214');
    await expect(
      service.updateSecuencial('em-1', 'pe-1', '01', {
        ultimoSecuencial: 1000,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(updates).toHaveLength(0);
  });
});
