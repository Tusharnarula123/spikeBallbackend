import { Controller, Get, Param, Query } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { LeaderboardService } from './leaderboard.service';

@Controller('leaderboard')
export class LeaderboardController {
  constructor(private readonly leaderboard: LeaderboardService) {}

  @Public()
  @Get()
  getActive(@Query('gender') gender?: string) {
    return this.leaderboard.getActive(gender);
  }

  @Public()
  @Get('semester/:semesterId')
  getBySemester(@Param('semesterId') semesterId: string, @Query('gender') gender?: string) {
    return this.leaderboard.getBySemester(semesterId, gender);
  }

  @Public()
  @Get('season/:seasonId')
  getBySeason(@Param('seasonId') seasonId: string, @Query('gender') gender?: string) {
    return this.leaderboard.getBySeason(seasonId, gender);
  }
}
