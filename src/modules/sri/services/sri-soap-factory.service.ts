import { Injectable, Logger } from '@nestjs/common';
import * as soap from 'soap';
import { Client } from 'soap';
import * as https from 'https';

@Injectable()
export class SriSoapFactoryService {
  private readonly logger = new Logger(SriSoapFactoryService.name);
  
  // Cache de clientes en memoria. Clave: tipo_ambiente (ej: 'recepcion_1')
  private clients = new Map<string, Client>();

  /**
   * Agente HTTPS configurado para compatibilidad con los servidores del SRI Ecuador.
   * Los servidores del SRI usan certificados/configuraciones TLS legacy que
   * Node.js v18+ (OpenSSL 3.x) rechaza por defecto.
   */
  private readonly sriHttpsAgent = new https.Agent({
    rejectUnauthorized: false,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.2',
    ciphers: 'DEFAULT:@SECLEVEL=0',
    keepAlive: false,
  });

  private readonly WSDL_URLS = {
    recepcion: {
      '1': 'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline?wsdl', // Pruebas
      '2': 'https://cel.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline?wsdl',    // Producción
    },
    autorizacion: {
      '1': 'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl', // Pruebas
      '2': 'https://cel.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl',    // Producción
    }
  };

  /** Opciones compartidas para la creación de clientes SOAP del SRI */
  private getSoapOptions() {
    return {
      wsdl_options: {
        httpsAgent: this.sriHttpsAgent,
        rejectUnauthorized: false,
      },
      request: require('axios').create({
        httpsAgent: this.sriHttpsAgent,
        timeout: 30000,
      }),
    };
  }

  /**
   * Obtiene (o crea y cachea) un cliente SOAP para el servicio de Recepción
   * @param ambiente '1' para Pruebas, '2' para Producción
   */
  async getRecepcionClient(ambiente: '1' | '2'): Promise<Client> {
    const cacheKey = `recepcion_${ambiente}`;
    
    if (this.clients.has(cacheKey)) {
      return this.clients.get(cacheKey)!;
    }

    const wsdlUrl = this.WSDL_URLS.recepcion[ambiente];
    if (!wsdlUrl) {
      throw new Error(`Ambiente no válido para recepción: ${ambiente}`);
    }

    this.logger.log(`Creando nuevo cliente SOAP de Recepción para ambiente ${ambiente}`);
    const options = this.getSoapOptions();
    const client = await soap.createClientAsync(wsdlUrl, options);
    client.setSecurity(new soap.ClientSSLSecurity(null as any, null as any, null as any, {
      rejectUnauthorized: false,
      agent: this.sriHttpsAgent,
    }));
    
    this.clients.set(cacheKey, client);
    return client;
  }

  /**
   * Obtiene (o crea y cachea) un cliente SOAP para el servicio de Autorización
   * @param ambiente '1' para Pruebas, '2' para Producción
   */
  async getAutorizacionClient(ambiente: '1' | '2'): Promise<Client> {
    const cacheKey = `autorizacion_${ambiente}`;
    
    if (this.clients.has(cacheKey)) {
      return this.clients.get(cacheKey)!;
    }

    const wsdlUrl = this.WSDL_URLS.autorizacion[ambiente];
    if (!wsdlUrl) {
      throw new Error(`Ambiente no válido para autorización: ${ambiente}`);
    }

    this.logger.log(`Creando nuevo cliente SOAP de Autorización para ambiente ${ambiente}`);
    const options = this.getSoapOptions();
    const client = await soap.createClientAsync(wsdlUrl, options);
    client.setSecurity(new soap.ClientSSLSecurity(null as any, null as any, null as any, {
      rejectUnauthorized: false,
      agent: this.sriHttpsAgent,
    }));
    
    this.clients.set(cacheKey, client);
    return client;
  }
}
