import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { SupabaseModule } from '../supabase/supabase.module';
import { GalleryController } from './gallery.controller';
import { GalleryService } from './gallery.service';

@Module({
  imports: [
    SupabaseModule,
    MulterModule.register({ storage: memoryStorage() }),
  ],
  controllers: [GalleryController],
  providers: [GalleryService],
})
export class GalleryModule {}
