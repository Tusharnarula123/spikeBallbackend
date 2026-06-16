import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import ws from 'ws';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/http-exception.filter';

// Supabase realtime requires WebSocket on Node < 22
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).WebSocket = ws;

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api');
  app.use(cookieParser());

  // FRONTEND_URL may be comma-separated to allow multiple origins
  // e.g. "https://spikeball-ou.vercel.app,https://spikeball-ou-git-main-user.vercel.app"
  const rawOrigins = process.env.FRONTEND_URL ?? 'http://localhost:3000';
  const allowedOrigins = rawOrigins.split(',').map((o) => o.trim()).filter(Boolean);
  app.enableCors({
    origin: allowedOrigins.length === 1 ? allowedOrigins[0] : allowedOrigins,
    credentials: true,
  });
  app.useGlobalFilters(new HttpExceptionFilter());

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
}
bootstrap();
