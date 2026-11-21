import {
  ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { ERROR_CODES, ErrorCode } from '@cps/shared';
import type { Request, Response } from 'express';
import { Prisma } from '../generated/prisma/client';

export interface FieldError {
  path: string;
  code: string;
  message: string;
}

/** Application error rendered as RFC 9457 Problem Details with a stable `code`. */
export class AppError extends HttpException {
  constructor(
    status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly errors?: FieldError[],
  ) {
    super(message, status);
  }
}

export const notFound = (what = 'Record') => new AppError(404, ERROR_CODES.NOT_FOUND, `${what} not found`);
export const forbidden = (msg = 'You do not have permission to do this') => new AppError(403, ERROR_CODES.FORBIDDEN, msg);
export const outOfScope = (msg = 'This record is outside your assigned classes') => new AppError(403, ERROR_CODES.OUT_OF_SCOPE, msg);
export const conflict = (code: ErrorCode, msg: string, errors?: FieldError[]) => new AppError(409, code, msg, errors);
export const invalid = (msg: string, errors?: FieldError[]) => new AppError(422, ERROR_CODES.VALIDATION_FAILED, msg, errors);

const TITLES: Record<number, string> = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict',
  413: 'Payload Too Large', 415: 'Unsupported Media Type', 422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error',
};

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    let status = 500;
    let code: string = 'INTERNAL_ERROR';
    let detail = 'Something went wrong. Please try again.';
    let errors: FieldError[] | undefined;

    if (exception instanceof AppError) {
      status = exception.getStatus();
      code = exception.code;
      detail = exception.message;
      errors = exception.errors;
    } else if (exception instanceof ThrottlerException) {
      status = 429;
      code = ERROR_CODES.RATE_LIMITED;
      detail = 'Too many attempts. Please wait a minute and try again.';
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      ({ status, code, detail } = mapPrismaError(exception));
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = status === 404 ? ERROR_CODES.NOT_FOUND : status === 413 ? 'PAYLOAD_TOO_LARGE' : `HTTP_${status}`;
      const r = exception.getResponse();
      detail = typeof r === 'string' ? r : ((r as { message?: string }).message ?? exception.message);
      if (Array.isArray(detail)) detail = detail.join('; ');
    }

    if (status >= 500) this.logger.error(exception instanceof Error ? exception.stack : String(exception));

    res
      .status(status)
      .type('application/problem+json')
      .json({
        type: 'about:blank',
        title: TITLES[status] ?? HttpStatus[status] ?? 'Error',
        status,
        code,
        detail,
        instance: req.originalUrl,
        ...(errors ? { errors } : {}),
      });
  }
}

function mapPrismaError(e: Prisma.PrismaClientKnownRequestError) {
  switch (e.code) {
    case 'P2002':
      return { status: 409, code: ERROR_CODES.DUPLICATE, detail: 'A record with the same unique value already exists.' };
    case 'P2003':
      return { status: 409, code: ERROR_CODES.IN_USE, detail: 'This record is linked to other records.' };
    case 'P2025':
      return { status: 404, code: ERROR_CODES.NOT_FOUND, detail: 'Record not found.' };
    default:
      return { status: 500, code: 'DATABASE_ERROR', detail: 'A database error occurred.' };
  }
}

/** True when a Prisma error is a unique-constraint violation (P2002), incl. functional unique indexes. */
export function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}
