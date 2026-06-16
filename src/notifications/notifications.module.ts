import { Module } from '@nestjs/common';
import { MailService } from '../lib/mail.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  controllers: [NotificationsController],
  providers:   [NotificationsService, MailService],
  exports:     [NotificationsService, MailService],
})
export class NotificationsModule {}
