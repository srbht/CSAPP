import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map, Observable } from 'rxjs';
import { Prisma } from '../generated/prisma/client';

/**
 * JSON-safe output: BigInt ids → number (ids stay far below 2^53), Decimal → number,
 * Date → ISO string. DATE columns arrive as UTC midnight; the web client shows them with slice(0,10).
 * Secret fields are always stripped as a safety net.
 */
const SECRET_KEYS = new Set(['passwordHash', 'tokenHash']);

export function toJson(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (Prisma.Decimal.isDecimal(value)) return (value as Prisma.Decimal).toNumber();
  if (Buffer.isBuffer(value)) return undefined;
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.has(k)) continue;
      out[k] = toJson(v);
    }
    return out;
  }
  return value;
}

@Injectable()
export class SerializeInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((v) => (v instanceof StreamMarker ? v : toJson(v))));
  }
}

/** Marker for handlers that write the response themselves (file streams). */
export class StreamMarker {}

export interface Page<T> {
  data: T[];
  meta: { page: number; pageSize: number; total: number };
}

export function page<T>(data: T[], total: number, q: { page: number; pageSize: number }): Page<T> {
  return { data, meta: { page: q.page, pageSize: q.pageSize, total } };
}

export const skipTake = (q: { page: number; pageSize: number }) => ({ skip: (q.page - 1) * q.pageSize, take: q.pageSize });
