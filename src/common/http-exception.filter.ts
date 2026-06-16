import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null && 'error' in body) {
        return response.status(status).json(body);
      }
      const message =
        typeof body === 'string'
          ? body
          : (body as { message?: string | string[] }).message;
      const text = Array.isArray(message) ? message.join(', ') : message ?? 'Error';
      return response.status(status).json({ error: text });
    }

    return response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ error: 'Internal server error' });
  }
}
