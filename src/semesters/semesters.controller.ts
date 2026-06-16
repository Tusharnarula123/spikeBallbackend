import {
  Body, Controller, Get, HttpCode, HttpStatus,
  Param, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { Public } from '../auth/public.decorator';
import { DEFAULT_ELO } from '../common/config';
import { SemestersService } from './semesters.service';

@Controller('semesters')
export class SemestersController {
  constructor(private readonly semesters: SemestersService) {}

  // ── Seasons ──────────────────────────────────────────────────────────────

  @Public()
  @Get('seasons')
  listSeasons() {
    return this.semesters.listSeasons();
  }

  @Post('seasons')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.CREATED)
  createSeason(@Body() body: Record<string, unknown>) {
    return this.semesters.createSeason({
      yearStart:   Number(body.yearStart),
      startingElo: body.startingElo ? Number(body.startingElo) : DEFAULT_ELO,
    });
  }

  // ── Semesters ─────────────────────────────────────────────────────────────

  @Public()
  @Get()
  list(@Query('seasonId') seasonId?: string) {
    return this.semesters.listSemesters(seasonId);
  }

  @Public()
  @Get('active')
  getActive() {
    return this.semesters.getActiveSemester();
  }

  @Patch(':id/activate')
  @UseGuards(AdminGuard)
  activate(@Param('id') id: string) {
    return this.semesters.activateSemester(id);
  }

  @Patch(':id')
  @UseGuards(AdminGuard)
  update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.semesters.updateSemester(id, body);
  }
}
