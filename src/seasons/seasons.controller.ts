import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { Public } from '../auth/public.decorator';
import { DEFAULT_ELO } from '../common/config';
import { SemestersService } from '../semesters/semesters.service';

@Controller('seasons')
export class SeasonsController {
  constructor(private readonly semesters: SemestersService) {}

  /** List all seasons with their semesters embedded. */
  @Public()
  @Get()
  list() {
    return this.semesters.listSeasons();
  }

  /**
   * Create a season for a given year.
   * Body: { yearStart: number, startingElo?: number }
   * Auto-creates Summer / Fall / Spring semesters.
   */
  @Post()
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.CREATED)
  create(@Body() body: Record<string, unknown>) {
    return this.semesters.createSeason({
      yearStart:   Number(body.yearStart),
      startingElo: body.startingElo ? Number(body.startingElo) : DEFAULT_ELO,
    });
  }

  /** Returns the active semester (with parent season). */
  @Public()
  @Get('active')
  getActive() {
    return this.semesters.getActiveSemester();
  }

  /**
   * Activate a specific semester by its ID.
   * PATCH /seasons/semester/:semesterId/activate
   */
  @Patch('semester/:semId/activate')
  @UseGuards(AdminGuard)
  activateSemester(@Param('semId') semId: string) {
    return this.semesters.activateSemester(semId);
  }

  /** Delete a season (and its semesters). Blocked if active or has recorded matches. */
  @Delete(':id')
  @UseGuards(AdminGuard)
  remove(@Param('id') id: string) {
    return this.semesters.deleteSeason(id);
  }
}
