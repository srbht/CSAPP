import { Global, Injectable, Module } from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { config } from '../config';

/**
 * Storage abstraction (docs/02 §10). v1 ships the local-disk driver; an S3-compatible
 * driver implements the same interface later without touching callers.
 */
export interface StorageDriver {
  readonly name: string;
  put(prefix: string, ext: string, data: Buffer): Promise<string>;
  read(key: string): Readable;
}

@Injectable()
export class LocalDiskStorage implements StorageDriver {
  readonly name = 'local';
  private readonly root = path.resolve(config().STORAGE_DIR);

  async put(prefix: string, ext: string, data: Buffer): Promise<string> {
    const safePrefix = prefix.replace(/[^a-zA-Z0-9/_-]/g, '');
    const key = `${safePrefix}/${randomUUID()}.${ext.replace(/[^a-z0-9]/g, '')}`;
    const full = this.resolveKey(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data, { flag: 'wx' });
    return key;
  }

  read(key: string): Readable {
    return createReadStream(this.resolveKey(key));
  }

  private resolveKey(key: string) {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error('Invalid storage key');
    return full;
  }
}

@Global()
@Module({ providers: [{ provide: 'STORAGE', useClass: LocalDiskStorage }], exports: ['STORAGE'] })
export class StorageModule {}

/** Detect image type from magic bytes. Never trust the client's Content-Type or file name. */
export function sniffImage(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}
