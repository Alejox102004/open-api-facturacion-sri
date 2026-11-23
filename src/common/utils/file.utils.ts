import { existsSync, mkdirSync, statSync, readdirSync, unlinkSync } from 'fs';
import { join, extname, parse, basename } from 'path';
import { BadRequestException } from '@nestjs/common';

/**
 * Format file size to human readable format
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Ensure a directory exists, create if not
 */
export function ensureDirectoryExists(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Get file stats with formatted info
 */
export function getFileInfo(filePath: string) {
  const stats = statSync(filePath);
  return {
    size: stats.size,
    sizeFormatted: formatFileSize(stats.size),
    createdAt: stats.birthtime,
    modifiedAt: stats.mtime,
  };
}

/**
 * List files in a directory with optional extension filter
 */
export function listFiles(
  dirPath: string,
  extensions?: string[],
): { name: string; stats: ReturnType<typeof getFileInfo> }[] {
  if (!existsSync(dirPath)) {
    return [];
  }

  return readdirSync(dirPath)
    .filter((file) => {
      if (!extensions || extensions.length === 0) return true;
      const ext = extname(file).toLowerCase();
      return extensions.includes(ext);
    })
    .map((file) => ({
      name: file,
      stats: getFileInfo(join(dirPath, file)),
    }));
}

/**
 * Delete a file if it exists
 */
export function deleteFile(filePath: string): boolean {
  if (existsSync(filePath)) {
    unlinkSync(filePath);
    return true;
  }
  return false;
}

/**
 * Get file name without extension
 */
export function getFileNameWithoutExt(fileName: string): string {
  return parse(fileName).name;
}

/**
 * Check if file has valid extension
 */
export function hasValidExtension(
  fileName: string,
  validExtensions: string[],
): boolean {
  const ext = extname(fileName).toLowerCase();
  return validExtensions.includes(ext);
}

/**
 * Rechaza nombres de archivo recibidos del cliente que intenten salir del
 * directorio base (separadores de ruta, "..", bytes nulos). Los nombres
 * legítimos nunca los contienen, así que es transparente para el uso normal.
 */
export function assertSafeFileName(fileName: unknown): asserts fileName is string {
  if (
    typeof fileName !== 'string' ||
    fileName.length === 0 ||
    fileName.length > 255 ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('\0') ||
    fileName === '.' ||
    fileName === '..' ||
    basename(fileName) !== fileName
  ) {
    throw new BadRequestException('Nombre de archivo inválido');
  }
}
