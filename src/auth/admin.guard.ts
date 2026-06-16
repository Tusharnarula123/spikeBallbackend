import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { AUTH_USER_KEY } from './auth.types';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.authUser;

    if (!user || user.role !== 'admin') {
      throw new ForbiddenException({ error: 'Forbidden' });
    }

    return true;
  }
}
