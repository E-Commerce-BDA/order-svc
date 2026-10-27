import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { getRequestId } from '../http/request-id.js';

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId: string;
  timestamp: string;
}

interface NormalizedError {
  code: string;
  message: string;
  details?: unknown;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();
    const requestId = getRequestId(request);

    // Readiness and liveness probes stay outside the API envelope
    if (isHealthPath(request)) {
      this.writeHealthResponse(exception, response);
      return;
    }

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const normalized = normalizeException(exception, status);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      const detail =
        exception instanceof Error
          ? (exception.stack ?? exception.message)
          : String(exception);
      this.logger.error(
        `[${requestId}] ${request.method} ${request.originalUrl ?? request.url}`,
        detail,
      );
    }

    const envelope: ErrorEnvelope = {
      error:
        normalized.details === undefined
          ? { code: normalized.code, message: normalized.message }
          : {
              code: normalized.code,
              message: normalized.message,
              details: normalized.details,
            },
      requestId,
      timestamp: new Date().toISOString(),
    };

    if (typeof response.setHeader === 'function') {
      response.setHeader('x-request-id', requestId);
    }
    response.status(status).json(envelope);
  }

  private writeHealthResponse(exception: unknown, response: Response): void {
    if (!(exception instanceof HttpException)) {
      response
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ status: 'error' });
      return;
    }

    const payload = exception.getResponse();
    if (typeof payload === 'string') {
      response.status(exception.getStatus()).json({
        statusCode: exception.getStatus(),
        message: payload,
      });
      return;
    }

    response.status(exception.getStatus()).json(payload);
  }
}

function normalizeException(
  exception: unknown,
  status: number,
): NormalizedError {
  const fallbackCode = defaultCode(status);

  if (!(exception instanceof HttpException)) {
    return {
      code: fallbackCode,
      message:
        status >= HttpStatus.INTERNAL_SERVER_ERROR
          ? 'Internal server error'
          : 'Request failed',
    };
  }

  const payload = exception.getResponse();
  if (typeof payload === 'string') {
    return {
      code: fallbackCode,
      message:
        status >= HttpStatus.INTERNAL_SERVER_ERROR
          ? 'Internal server error'
          : payload,
    };
  }

  if (!isRecord(payload)) {
    return {
      code: fallbackCode,
      message:
        status >= HttpStatus.INTERNAL_SERVER_ERROR
          ? 'Internal server error'
          : exception.message,
    };
  }

  const code =
    typeof payload.code === 'string' && payload.code.length > 0
      ? payload.code
      : fallbackCode;
  const rawMessage = payload.message;
  let message: string;
  let details: unknown;

  if (Array.isArray(rawMessage)) {
    message = 'Validation failed';
    details = rawMessage;
  } else if (typeof rawMessage === 'string' && rawMessage.length > 0) {
    message =
      status >= HttpStatus.INTERNAL_SERVER_ERROR
        ? 'Internal server error'
        : rawMessage;
  } else {
    message =
      status >= HttpStatus.INTERNAL_SERVER_ERROR
        ? 'Internal server error'
        : exception.message;
  }

  if (payload.details !== undefined) {
    details = payload.details;
  }

  return details === undefined
    ? { code, message }
    : { code, message, details };
}

function defaultCode(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return 'VALIDATION_FAILED';
    case HttpStatus.UNAUTHORIZED:
      return 'UNAUTHENTICATED';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN';
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.CONFLICT:
      return 'CONFLICT';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'RATE_LIMITED';
    case HttpStatus.SERVICE_UNAVAILABLE:
      return 'SERVICE_UNAVAILABLE';
    default:
      return status >= HttpStatus.INTERNAL_SERVER_ERROR
        ? 'INTERNAL_ERROR'
        : 'REQUEST_FAILED';
  }
}

function isHealthPath(request: Request): boolean {
  const path = request.path ?? request.url ?? '';
  return path === '/health' || path.startsWith('/health/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
