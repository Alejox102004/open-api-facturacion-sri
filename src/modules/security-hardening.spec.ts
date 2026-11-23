/**
 * Regresiones de la rama fix/security-hardening del microservicio.
 * Cada bloque fija el comportamiento seguro de un hallazgo de la auditoría.
 */
import { BadRequestException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { assertSafeFileName } from '../common/utils/file.utils';
import { WebhooksService, isPrivateAddress } from './webhooks/webhooks.service';
import { EmisoresService } from './emisores/emisores.service';
import { SriService } from './sri/sri.service';
import { AuthService } from './auth/auth.service';
import { JwtPayload, UserRole } from './auth/dto/auth.dto';

const superadmin = { sub: 'sa', rol: UserRole.SUPERADMIN, tenantId: undefined } as unknown as JwtPayload;
const tenantA = { sub: 'u-a', rol: UserRole.ADMIN, tenantId: 'tenant-a' } as unknown as JwtPayload;
const tenantB = { sub: 'u-b', rol: UserRole.ADMIN, tenantId: 'tenant-b' } as unknown as JwtPayload;
const noTenant = { sub: 'u-x', rol: UserRole.ADMIN, tenantId: undefined } as unknown as JwtPayload;

describe('assertSafeFileName', () => {
  it.each(['firma.p12', 'documento_123.pdf', 'logo empresa.png'])('acepta %s', (name) => {
    expect(() => assertSafeFileName(name)).not.toThrow();
  });

  it.each(['../certs/firma.p12', '..', 'a/b.pdf', 'a\\b.pdf', '..\\..\\app\\main.js', '', 'x\0.p12'])(
    'rechaza %p',
    (name) => {
      expect(() => assertSafeFileName(name)).toThrow(BadRequestException);
    },
  );
});

describe('isPrivateAddress', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1'])(
    '%s es interna',
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );

  it.each(['8.8.8.8', '186.4.1.10', '172.32.0.1', '2800:bf0::1'])('%s es pública', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe('WebhooksService', () => {
  const makeService = (rows: Record<string, unknown>[] = []) => {
    const db = { query: jest.fn().mockResolvedValue({ rows }) };
    const queue = { add: jest.fn() };
    return { service: new WebhooksService(db as any, queue as any), db, queue };
  };

  describe('assertAccess', () => {
    it('permite al tenant dueño y a SUPERADMIN', async () => {
      const { service } = makeService([{ tenant_id: 'tenant-a' }]);
      await expect(service.assertAccess('wh-1', tenantA)).resolves.toBeUndefined();
      await expect(service.assertAccess('wh-1', superadmin)).resolves.toBeUndefined();
    });

    it('devuelve 404 a otro tenant, a un usuario sin tenant y para webhooks globales', async () => {
      await expect(makeService([{ tenant_id: 'tenant-a' }]).service.assertAccess('wh-1', tenantB)).rejects.toThrow(NotFoundException);
      await expect(makeService([{ tenant_id: 'tenant-a' }]).service.assertAccess('wh-1', noTenant)).rejects.toThrow(NotFoundException);
      await expect(makeService([{ tenant_id: null }]).service.assertAccess('wh-1', tenantA)).rejects.toThrow(NotFoundException);
      await expect(makeService([]).service.assertAccess('wh-x', tenantA)).rejects.toThrow(NotFoundException);
    });
  });

  describe('assertSafeUrl', () => {
    const { service } = makeService();

    it('rechaza destinos internos para usuarios de un tenant', async () => {
      for (const url of ['http://127.0.0.1:6379/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://localhost:3001/', 'file:///etc/passwd']) {
        await expect(service.assertSafeUrl(url, tenantA)).rejects.toThrow(BadRequestException);
      }
    });

    it('acepta IPs públicas y deja a SUPERADMIN registrar la URL del backend local', async () => {
      await expect(service.assertSafeUrl('https://8.8.8.8/hook', tenantA)).resolves.toBeUndefined();
      await expect(service.assertSafeUrl('http://127.0.0.1:8000/api/sri/webhook', superadmin)).resolves.toBeUndefined();
    });
  });

  describe('emit', () => {
    it('limita los destinatarios al tenant del emisor o a webhooks globales', async () => {
      const { service, db } = makeService([]);
      await service.emit('comprobante.autorizado' as any, { claveAcceso: 'x' }, 'emisor-1');
      const [sql, params] = db.query.mock.calls[0];
      expect(sql).toContain('tenant_id IS NULL OR tenant_id = (SELECT tenant_id FROM emisores WHERE id = $2)');
      expect(params).toEqual(['comprobante.autorizado', 'emisor-1']);
    });

    it('sin emisor solo notifica a webhooks globales', async () => {
      const { service, db } = makeService([]);
      await service.emit('comprobante.autorizado' as any, { claveAcceso: 'x' });
      expect(db.query.mock.calls[0][0]).toContain('AND tenant_id IS NULL');
    });
  });
});

describe('EmisoresService.validateRucAccess', () => {
  const serviceWith = (tenantId: string | null) => {
    const service = new EmisoresService({} as any, {} as any);
    jest.spyOn(service, 'findByRuc').mockResolvedValue({ id: 'e1', ruc: '1790011223001', tenantId } as any);
    return service;
  };

  it('permite al tenant dueño y a SUPERADMIN', async () => {
    await expect(serviceWith('tenant-a').validateRucAccess('1790011223001', tenantA)).resolves.toBeDefined();
    await expect(serviceWith(null).validateRucAccess('1790011223001', superadmin)).resolves.toBeDefined();
  });

  it('niega a otro tenant y los emisores sin tenant a usuarios de un tenant', async () => {
    await expect(serviceWith('tenant-a').validateRucAccess('1790011223001', tenantB)).rejects.toThrow(ForbiddenException);
    await expect(serviceWith(null).validateRucAccess('1790011223001', tenantA)).rejects.toThrow(ForbiddenException);
  });
});

describe('SriService.sincronizarConSri', () => {
  it('filtra los comprobantes por el RUC solicitado', async () => {
    const service = Object.create(SriService.prototype) as SriService;
    (service as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    (service as any).configService = { get: (_k: string, d: unknown) => d };
    const listar = jest.spyOn(service, 'listarComprobantes').mockResolvedValue({ data: [], meta: { total: 0, page: 1, limit: 50, totalPages: 0 } });

    await service.sincronizarConSri({ rucEmisor: '1790011223001' });

    expect(listar).toHaveBeenCalledWith(expect.objectContaining({ rucEmisor: '1790011223001' }));
  });
});

describe('AuthService.refreshToken', () => {
  const build = (dbUser: Record<string, unknown> | null) => {
    const jwt = {
      verify: jest.fn().mockReturnValue({ sub: 'u1', rol: 'SUPERADMIN', tenantId: 'viejo', type: 'refresh' }),
      sign: jest.fn().mockReturnValue('token'),
      decode: jest.fn().mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    };
    const db = { queryOne: jest.fn().mockResolvedValue(dbUser) };
    const config = { get: (_k: string, d: unknown) => d };
    return { service: new AuthService(db as any, jwt as any, config as any), jwt };
  };

  it('emite tokens con el rol y tenant actuales de la BD', async () => {
    const { service, jwt } = build({ id: 'u1', email: 'a@b.c', rol: 'USER', tenant_id: 'tenant-a', activo: true });
    const res = await service.refreshToken({ refreshToken: 'r' } as any);
    expect(res.user.rol).toBe('USER');
    expect(res.user.tenantId).toBe('tenant-a');
    expect(jwt.sign.mock.calls[0][0]).toMatchObject({ rol: 'USER', tenantId: 'tenant-a', type: 'access' });
  });

  it('rechaza usuarios desactivados', async () => {
    const { service } = build({ id: 'u1', email: 'a@b.c', rol: 'USER', tenant_id: null, activo: false });
    await expect(service.refreshToken({ refreshToken: 'r' } as any)).rejects.toThrow(UnauthorizedException);
  });
});
