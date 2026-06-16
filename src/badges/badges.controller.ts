import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { AuthUser } from '../auth/auth-user.decorator';
import type { ClerkUser } from '../auth/auth.types';
import { Public } from '../auth/public.decorator';
import { BadgesService } from './badges.service';

@Controller('badges')
export class BadgesController {
  constructor(private readonly badges: BadgesService) {}

  @Public()
  @Get()
  list() {
    return this.badges.list();
  }

  @Post('award')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.CREATED)
  award(@AuthUser() auth: ClerkUser, @Body() body: Record<string, unknown>) {
    return this.badges.award(auth, body);
  }
}
