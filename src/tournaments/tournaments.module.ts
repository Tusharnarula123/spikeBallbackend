import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { TournamentsController } from './tournaments.controller';
import { TournamentsService } from './tournaments.service';

@Module({
  imports:     [NotificationsModule],
  controllers: [TournamentsController],
  providers:   [TournamentsService],
})
export class TournamentsModule {}
