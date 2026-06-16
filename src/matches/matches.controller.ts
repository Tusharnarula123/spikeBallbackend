import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { AuthUser } from '../auth/auth-user.decorator';
import type { ClerkUser } from '../auth/auth.types';
import { Public } from '../auth/public.decorator';
import { MatchesService } from './matches.service';

@Controller('matches')
export class MatchesController {
  constructor(private readonly matches: MatchesService) {}

  @Public()
  @Get()
  list(
    @Query('playerId') playerId?: string,
    @Query('seasonId') seasonId?: string,
    @Query('status') status?: string,
  ) {
    return this.matches.list({ playerId, seasonId, status });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  submit(@AuthUser() auth: ClerkUser, @Body() body: Record<string, unknown>) {
    return this.matches.submit(auth, body);
  }

  @Get('me')
  getMyMatches(@AuthUser() auth: ClerkUser, @Query('seasonId') seasonId?: string) {
    return this.matches.getMyMatches(auth, seasonId);
  }

  @Get('pending')
  @UseGuards(AdminGuard)
  listPending() {
    return this.matches.listPending();
  }

  @Patch(':id')
  @UseGuards(AdminGuard)
  update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.matches.update(id, body);
  }

  @Patch(':id/approve')
  @UseGuards(AdminGuard)
  approve(@AuthUser() auth: ClerkUser, @Param('id') id: string) {
    return this.matches.approve(auth, id);
  }

  @Patch(':id/dispute')
  @UseGuards(AdminGuard)
  dispute(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.matches.dispute(id, body?.notes as string | undefined);
  }

  @Patch(':id/cancel')
  @UseGuards(AdminGuard)
  cancel(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.matches.cancel(id, body?.notes as string | undefined);
  }
}
