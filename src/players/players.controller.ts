import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { AuthUser } from '../auth/auth-user.decorator';
import type { ClerkUser } from '../auth/auth.types';
import { Public } from '../auth/public.decorator';
import { PlayersService } from './players.service';

@Controller('players')
export class PlayersController {
  constructor(private readonly players: PlayersService) {}

  @Public()
  @Get('search')
  searchPublic(@Query('q') q?: string) {
    return this.players.searchPublic(q);
  }

  @Get()
  list(
    @AuthUser() auth: ClerkUser,
    @Query('status') status?: string,
    @Query('excludeSelf') excludeSelf?: string,
    @Query('search') search?: string,
  ) {
    return this.players.list(auth, { status, excludeSelf, search });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  register(@AuthUser() auth: ClerkUser, @Body() body: Record<string, unknown>) {
    return this.players.register(auth, body);
  }

  @Get('pending')
  @UseGuards(AdminGuard)
  listPending() {
    return this.players.listPending();
  }

  @Get('all')
  @UseGuards(AdminGuard)
  listAll(@Query('search') search?: string) {
    return this.players.listAll(search);
  }

  @Get(':id')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.players.getById(id);
  }

  @Public()
  @Get(':id/elo-history')
  getEloHistory(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('semesterId') semesterId?: string,
    @Query('seasonId')   seasonId?: string,
  ) {
    return this.players.getEloHistory(id, semesterId, seasonId);
  }

  @Public()
  @Get(':id/profile')
  getPublicProfile(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('seasonId')   seasonId?: string,
    @Query('semesterId') semesterId?: string,
  ) {
    return this.players.getPublicProfile(id, seasonId, semesterId);
  }

  @Public()
  @Get(':id/match-history')
  getPlayerMatchHistory(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('seasonId')   seasonId?: string,
    @Query('semesterId') semesterId?: string,
  ) {
    return this.players.getPlayerMatchHistory(id, seasonId, semesterId);
  }

  @Public()
  @Get(':id/vs/:otherId')
  getHeadToHead(
    @Param('id', ParseUUIDPipe)      id: string,
    @Param('otherId', ParseUUIDPipe) otherId: string,
  ) {
    return this.players.getHeadToHead(id, otherId);
  }

  @Patch(':id/approve')
  @UseGuards(AdminGuard)
  approve(@Param('id', ParseUUIDPipe) id: string) {
    return this.players.approve(id);
  }

  @Patch(':id/suspend')
  @UseGuards(AdminGuard)
  suspend(@Param('id', ParseUUIDPipe) id: string) {
    return this.players.suspend(id);
  }

  @Delete(':id/reject')
  @UseGuards(AdminGuard)
  reject(@Param('id', ParseUUIDPipe) id: string) {
    return this.players.reject(id);
  }
}
