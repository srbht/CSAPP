import { PipeTransform } from '@nestjs/common';
import { ERROR_CODES } from '@cps/shared';
import { z } from 'zod';
import { AppError } from './errors';

/** Validates request body/query with a shared Zod schema → 422 with field errors. */
export class ZodPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const r = this.schema.safeParse(value ?? {});
    if (r.success) return r.data;
    throw new AppError(
      422,
      ERROR_CODES.VALIDATION_FAILED,
      'Please correct the highlighted fields.',
      r.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message })),
    );
  }
}

export const zBody = <T extends z.ZodType>(schema: T) => new ZodPipe(schema);

/** Route param id → bigint, 404 on garbage. */
export class IdPipe implements PipeTransform<string, bigint> {
  transform(value: string): bigint {
    if (!/^\d{1,18}$/.test(value)) throw new AppError(404, ERROR_CODES.NOT_FOUND, 'Record not found');
    return BigInt(value);
  }
}

export const big = (n: number | bigint | null | undefined): bigint | null => (n == null ? null : BigInt(n));
export const dateOnly = (s: string | null | undefined): Date | null => (s ? new Date(`${s}T00:00:00.000Z`) : null);
