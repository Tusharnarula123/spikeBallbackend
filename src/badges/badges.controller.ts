import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
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

  /**
   * Create a new badge type.
   * Body: { name, description, iconName?, triggerType?, triggerValue?, tournamentId? }
   * Optional multipart field `icon` — a custom uploaded icon image (stored on Cloudinary).
   * At least one of `iconName` or `icon` must be provided.
   */
  @Post()
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('icon'))
  create(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    return this.badges.create(body, file);
  }

  /** Delete a badge type. Blocked if any player already holds it. */
  @Delete(':id')
  @UseGuards(AdminGuard)
  remove(@Param('id') id: string) {
    return this.badges.delete(id);
  }

  /** Body: { playerId, badgeId, tournamentId? } */
  @Post('award')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.CREATED)
  award(@AuthUser() auth: ClerkUser, @Body() body: Record<string, unknown>) {
    return this.badges.award(auth, body);
  }
}
