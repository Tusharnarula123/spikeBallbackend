import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';
import { AuthUser } from '../auth/auth-user.decorator';
import type { ClerkUser } from '../auth/auth.types';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /** GET /notifications          — list notifications (optionally unread only) */
  /** GET /notifications?unread=1 — unread only                                  */
  @Get()
  list(
    @AuthUser() auth: ClerkUser,
    @Query('unread') unread?: string,
    @Query('limit')  limit?: string,
  ) {
    return this.notifications.list(auth, {
      unreadOnly: unread === '1' || unread === 'true',
      limit: limit ? Number(limit) : undefined,
    });
  }

  /** GET /notifications/count — { count: number } */
  @Get('count')
  async count(@AuthUser() auth: ClerkUser) {
    const count = await this.notifications.unreadCount(auth);
    return { count };
  }

  /** PATCH /notifications/read-all */
  @Patch('read-all')
  @HttpCode(HttpStatus.OK)
  markAllRead(@AuthUser() auth: ClerkUser) {
    return this.notifications.markAllRead(auth);
  }

  /** PATCH /notifications/:id/read */
  @Patch(':id/read')
  @HttpCode(HttpStatus.OK)
  markRead(
    @AuthUser() auth: ClerkUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notifications.markRead(auth, id);
  }

  /** DELETE /notifications/read — clear all read notifications */
  @Delete('read')
  @HttpCode(HttpStatus.OK)
  deleteRead(@AuthUser() auth: ClerkUser) {
    return this.notifications.deleteRead(auth);
  }

  /** DELETE /notifications/:id — remove a single notification (e.g. once acted on) */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  deleteOne(
    @AuthUser() auth: ClerkUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notifications.deleteOne(auth, id);
  }
}
