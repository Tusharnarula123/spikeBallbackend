import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { Public } from '../auth/public.decorator';
import { AboutService } from './about.service';

@Controller('about')
export class AboutController {
  constructor(private readonly about: AboutService) {}

  @Public()
  @Get()
  get() {
    return this.about.get();
  }

  @Patch()
  @UseGuards(AdminGuard)
  update(@Body() body: Record<string, unknown>) {
    return this.about.update(body);
  }
}
