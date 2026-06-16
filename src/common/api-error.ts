import { HttpException, HttpStatus } from '@nestjs/common';

export function apiError(message: string, status = HttpStatus.BAD_REQUEST): never {
  throw new HttpException({ error: message }, status);
}
