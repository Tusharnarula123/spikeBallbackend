import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { MatchesController } from './matches.controller';
import { MatchesService } from './matches.service';

@Module({
  imports:     [NotificationsModule],
  controllers: [MatchesController],
  providers:   [MatchesService],
})
export class MatchesModule {}
