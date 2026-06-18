import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { AnnouncementsService } from './announcements.service';

@Controller('announcements')
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Public()
  @Get()
  list() {
    return this.announcements.list();
  }
}
