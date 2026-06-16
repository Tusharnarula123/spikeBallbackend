import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ClerkUser } from './auth.types';

export const AuthUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ClerkUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.authUser!;
  },
);
