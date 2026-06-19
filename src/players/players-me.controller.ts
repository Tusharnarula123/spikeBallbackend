import { Body, Controller, Delete, Get, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthUser } from '../auth/auth-user.decorator';
import type { ClerkUser } from '../auth/auth.types';
import { apiError } from '../common/api-error';
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

  @Post('avatar')
  @UseInterceptors(FileInterceptor('avatar'))
  uploadAvatar(@AuthUser() auth: ClerkUser, @UploadedFile() file: Express.Multer.File) {
    if (!file) apiError('No file uploaded');
    return this.players.uploadAvatar(auth, file.buffer);
  }

  @Delete('avatar')
  removeAvatar(@AuthUser() auth: ClerkUser) {
    return this.players.removeAvatar(auth);
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
