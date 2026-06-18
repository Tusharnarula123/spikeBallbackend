import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  Body,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AdminGuard } from '../auth/admin.guard';
import { Public } from '../auth/public.decorator';
import { GalleryService } from './gallery.service';

@Controller('gallery')
export class GalleryController {
  constructor(private readonly gallery: GalleryService) {}

  @Public()
  @Get()
  list() {
    return this.gallery.list();
  }

  @Post()
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('image'))
  upload(
    @UploadedFile() file: Express.Multer.File,
    @Body('altText') altText: string,
  ) {
    return this.gallery.upload(file.buffer, file.originalname, altText ?? '');
  }

  @Delete(':id')
  @UseGuards(AdminGuard)
  remove(@Param('id') id: string) {
    return this.gallery.remove(id);
  }
}
