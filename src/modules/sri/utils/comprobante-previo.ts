import { Logger } from '@nestjs/common';
import type { SriRepositoryService } from '../services/sri-repository.service';
import type { SriSoapClient } from '../services/sri-soap.client';

/**
 * Respuesta que se devuelve cuando ya existe un comprobante previo para la
 * misma referencia externa (misma forma que FacturaResponseDto y
 * NotaCreditoResponseDto).
 */
export interface RespuestaComprobantePrevio {
  success: boolean;
  claveAcceso: string;
  estado: string;
  fechaAutorizacion?: string;
  numeroAutorizacion?: string;
  mensajes: {
    identificador: string;
    mensaje: string;
    tipo: string;
  }[];
}

/**
 * Textos propios de cada tipo de comprobante para los mensajes de respuesta.
 */
export interface TextosComprobantePrevio {
  /** Prefijo de los identificadores de mensaje, p. ej. FACTURA_EXISTENTE */
  identificador: string;
  /** Nombre para los logs, p. ej. "Factura" */
  etiqueta: string;
  /** Mensaje cuando el comprobante previo ya está autorizado */
  mensajeAutorizado: string;
  /** Mensaje cuando el comprobante previo todavía puede autorizarse */
  mensajePendiente: (estadoLocal: string) => string;
}

export interface DependenciasComprobantePrevio {
  repository: Pick<
    SriRepositoryService,
    'findComprobantesByReferenciaExterna' | 'updateComprobante'
  >;
  sriSoapClient: Pick<SriSoapClient, 'autorizarComprobante'>;
  logger: Logger;
}

/** Estados locales con los que el SRI ya descartó el comprobante */
const ESTADOS_RECHAZADOS = ['DEVUELTA', 'RECHAZADO', 'NO AUTORIZADO', 'ERROR'];

/**
 * Busca un comprobante anterior del emisor, del mismo tipo y con la misma
 * referencia externa, que esté autorizado o que todavía pueda autorizarse.
 * Devuelve su respuesta, o null si no hay ninguno y se puede emitir uno nuevo
 * sin riesgo de duplicar.
 */
export async function buscarComprobantePrevio(
  deps: DependenciasComprobantePrevio,
  emisorId: string,
  tipoComprobante: string,
  referenciaExterna: string,
  textos: TextosComprobantePrevio,
): Promise<RespuestaComprobantePrevio | null> {
  const { repository, sriSoapClient, logger } = deps;
  const previas = await repository.findComprobantesByReferenciaExterna(
    emisorId,
    tipoComprobante,
    referenciaExterna,
  );

  for (const previa of previas) {
    const claveAcceso = previa.clave_acceso;
    if (!claveAcceso) {
      continue;
    }

    if (previa.estado === 'AUTORIZADO') {
      logger.warn(
        `${textos.etiqueta} para referencia ${referenciaExterna} ya autorizada (${claveAcceso}); no se emite otra`,
      );
      return respuestaAutorizada(
        claveAcceso,
        previa.fecha_autorizacion,
        previa.numero_autorizacion || claveAcceso,
        textos,
      );
    }

    let estadoSri: string | null = null;
    let fechaAutorizacion: string | undefined;
    let numeroAutorizacion: string | undefined;
    try {
      const respuesta = await sriSoapClient.autorizarComprobante(claveAcceso);
      const autorizaciones = respuesta?.autorizaciones?.autorizacion;
      const auth = Array.isArray(autorizaciones)
        ? autorizaciones[0]
        : autorizaciones;
      if (auth) {
        estadoSri = auth.estado || 'DESCONOCIDO';
        fechaAutorizacion = auth.fechaAutorizacion;
        numeroAutorizacion = auth.numeroAutorizacion;
      }
    } catch (error) {
      // Sin respuesta del SRI no se puede descartar que la anterior se
      // autorice: no emitir otra.
      logger.warn(
        `No se pudo consultar ${claveAcceso} en el SRI: ${(error as Error).message}`,
      );
      return respuestaComprobantePendiente(claveAcceso, previa.estado, textos);
    }

    if (estadoSri === 'AUTORIZADO') {
      await repository.updateComprobante(previa.id as string, {
        estado: 'AUTORIZADO',
        estado_sri: 'AUTORIZADO',
        fecha_autorizacion: fechaAutorizacion,
        numero_autorizacion: numeroAutorizacion || claveAcceso,
      });
      logger.warn(
        `${textos.etiqueta} previa ${claveAcceso} estaba AUTORIZADA en el SRI; no se emite otra`,
      );
      return respuestaAutorizada(
        claveAcceso,
        fechaAutorizacion,
        numeroAutorizacion || claveAcceso,
        textos,
      );
    }

    if (estadoSri && estadoSri !== 'NO AUTORIZADO') {
      // EN PROCESO u otro estado no definitivo
      return respuestaComprobantePendiente(claveAcceso, 'EN_PROCESO', textos);
    }

    if (estadoSri === null) {
      // El SRI no lo tiene registrado. Si la recepción no lo rechazó, puede
      // seguir en camino: se reenvía ese mismo (mismo secuencial y clave).
      if (!ESTADOS_RECHAZADOS.includes(previa.estado)) {
        return respuestaComprobantePendiente(
          claveAcceso,
          previa.estado,
          textos,
        );
      }
    }
    // NO AUTORIZADO o devuelto y no registrado en el SRI: ese no cuenta,
    // revisar el siguiente.
  }

  return null;
}

function respuestaAutorizada(
  claveAcceso: string,
  fechaAutorizacion: string | undefined,
  numeroAutorizacion: string,
  textos: TextosComprobantePrevio,
): RespuestaComprobantePrevio {
  return {
    success: true,
    claveAcceso,
    estado: 'AUTORIZADO',
    fechaAutorizacion,
    numeroAutorizacion,
    mensajes: [
      {
        identificador: textos.identificador,
        mensaje: textos.mensajeAutorizado,
        tipo: 'INFORMATIVO',
      },
    ],
  };
}

export function respuestaComprobantePendiente(
  claveAcceso: string,
  estadoLocal: string,
  textos: TextosComprobantePrevio,
): RespuestaComprobantePrevio {
  return {
    success: false,
    claveAcceso,
    estado: 'PENDIENTE',
    mensajes: [
      {
        identificador: `${textos.identificador}_PENDIENTE`,
        mensaje: textos.mensajePendiente(estadoLocal),
        tipo: 'ADVERTENCIA',
      },
    ],
  };
}
