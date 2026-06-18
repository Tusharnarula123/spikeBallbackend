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
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { AuthUser } from '../auth/auth-user.decorator';
import type { ClerkUser } from '../auth/auth.types';
import { TournamentsService } from './tournaments.service';

@Controller('tournaments')
export class TournamentsController {
  constructor(private readonly tournaments: TournamentsService) {}

  @Get()
  list(@Query('status') status?: string) {
    return this.tournaments.list(status);
  }

  @Post()
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.CREATED)
  create(@AuthUser() auth: ClerkUser, @Body() body: Record<string, unknown>) {
    return this.tournaments.create(auth, body);
  }

  @Get('me')
  getMyRegistrations(@AuthUser() auth: ClerkUser) {
    return this.tournaments.getMyRegistrations(auth);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.tournaments.getById(id);
  }

  @Patch(':id')
  @UseGuards(AdminGuard)
  update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.tournaments.update(id, body);
  }

  @Delete(':id')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  deleteTournament(@Param('id') id: string) {
    return this.tournaments.deleteTournament(id);
  }

  @Post(':id/register')
  @HttpCode(HttpStatus.CREATED)
  register(
    @AuthUser() auth: ClerkUser,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.tournaments.register(auth, id, body);
  }

  @Delete(':id/register')
  unregister(@AuthUser() auth: ClerkUser, @Param('id') id: string) {
    return this.tournaments.unregister(auth, id);
  }

  @Get(':id/registrations')
  @UseGuards(AdminGuard)
  listRegistrations(@Param('id') id: string) {
    return this.tournaments.listRegistrations(id);
  }

  @Get(':id/bracket')
  getBracket(@Param('id') id: string) {
    return this.tournaments.getBracket(id);
  }

  @Post(':id/generate-bracket')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.CREATED)
  generateBracket(@Param('id') id: string) {
    return this.tournaments.generateBracket(id);
  }

  @Post(':id/generate-round-robin')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.CREATED)
  generateRoundRobin(@Param('id') id: string) {
    return this.tournaments.generateRoundRobin(id);
  }

  @Post(':id/generate-finals')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.CREATED)
  generateRRFinals(@Param('id') id: string) {
    return this.tournaments.generateRRFinals(id);
  }

  @Post(':id/form-teams')
  @UseGuards(AdminGuard)
  formTeams(@Param('id') id: string) {
    return this.tournaments.formTeams(id);
  }
}
