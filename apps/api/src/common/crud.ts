import { ERROR_CODES } from '@cps/shared';
import { AppError, isUniqueViolation } from './errors';

/** Run a write; turn a unique-constraint violation into a friendly 409 on a specific field. */
export async function unique<T>(fn: () => Promise<T>, field: string, message: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError(409, ERROR_CODES.DUPLICATE, message, [{ path: field, code: 'duplicate', message }]);
    throw e;
  }
}

export function invalidState(message: string) {
  return new AppError(409, ERROR_CODES.INVALID_STATE, message);
}
