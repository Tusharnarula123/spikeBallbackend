import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { AdminGuard } from './admin.guard';
import { ClerkService } from './clerk.service';

@Global()
@Module({
  providers: [
    ClerkService,
    AdminGuard,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [ClerkService, AdminGuard],
})
export class AuthModule {}
