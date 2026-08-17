import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/public.decorator';

/**
 * Render pings this to decide whether a deploy is healthy. It must be
 * reachable with no auth and outside the /api prefix — see the
 * setGlobalPrefix(exclude: ['health']) call in main.ts, which is what
 * makes this resolve at exactly /health instead of /api/health.
 */
@Controller()
export class AppController {
  @Public()
  @Get('health')
  health() {
    return { status: 'ok' };
  }
}
