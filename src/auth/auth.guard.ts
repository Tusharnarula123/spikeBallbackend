import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { ClerkService } from './clerk.service';
import { AUTH_USER_KEY } from './auth.types';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly clerk: ClerkService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);
    if (!token && process.env.NODE_ENV !== 'production') {
      console.warn('[AuthGuard] No Bearer token or session cookie on protected route');
    }

    const user = await this.clerk.verifyRequestToken(token);

    if (!user) {
      throw new UnauthorizedException({ error: 'Unauthorized' });
    }

    request.authUser = user;
    return true;
  }

  private extractToken(req: Request): string | undefined {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      return auth.slice(7);
    }
    const cookie = req.cookies?.__session ?? req.cookies?.__clerk_db_jwt;
    return typeof cookie === 'string' ? cookie : undefined;
  }
}
