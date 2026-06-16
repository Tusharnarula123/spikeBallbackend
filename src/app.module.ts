import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AnnouncementsModule } from './announcements/announcements.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AuthModule } from './auth/auth.module';
import { BadgesModule } from './badges/badges.module';
import { LeaderboardModule } from './leaderboard/leaderboard.module';
import { MatchesModule } from './matches/matches.module';
import { PlayersModule } from './players/players.module';
import { SeasonsModule } from './seasons/seasons.module';
import { SemestersModule } from './semesters/semesters.module';
import { SupabaseModule } from './supabase/supabase.module';
import { TournamentsModule } from './tournaments/tournaments.module';
import { RedisModule } from './lib/redis.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../.env'],
    }),
    RedisModule,
    SupabaseModule,
    AuthModule,
    PlayersModule,
    MatchesModule,
    TournamentsModule,
    SeasonsModule,
    SemestersModule,
    LeaderboardModule,
    BadgesModule,
    AnnouncementsModule,
    NotificationsModule,
  ],
})
export class AppModule {}
