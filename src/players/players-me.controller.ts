import { Body, Controller, Get, Patch, Query } from '@nestjs/common';
import { AuthUser } from '../auth/auth-user.decorator';
import type { ClerkUser } from '../auth/auth.types';
import { PlayersService } from './players.service';

/** Separate controller so /players/me never collides with /players/:id */
@Controller('players/me')
export class PlayersMeController {
  constructor(private readonly players: PlayersService) {}

  @Get()
  getMe(@AuthUser() auth: ClerkUser) {
    return this.players.getMe(auth);
  }

  @Patch()
  updateMe(@AuthUser() auth: ClerkUser, @Body() body: Record<string, unknown>) {
    return this.players.updateMe(auth, body);
  }

  @Get('alltime')
  getAlltime(@AuthUser() auth: ClerkUser) {
    return this.players.getAlltime(auth);
  }

  @Get('elo-history')
  getMyEloHistory(@AuthUser() auth: ClerkUser, @Query('seasonId') seasonId?: string) {
    return this.players.getMyEloHistory(auth, seasonId);
  }
}
