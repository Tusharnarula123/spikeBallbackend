import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { BadgesController } from './badges.controller';
import { BadgesService } from './badges.service';

@Module({
  imports: [MulterModule.register({ storage: memoryStorage() })],
  controllers: [BadgesController],
  providers: [BadgesService],
})
export class BadgesModule {}
