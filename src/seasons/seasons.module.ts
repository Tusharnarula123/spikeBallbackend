import { Module } from '@nestjs/common';
import { SeasonsController } from './seasons.controller';
import { SeasonsService } from './seasons.service';
import { SemestersModule } from '../semesters/semesters.module';

@Module({
  imports:     [SemestersModule],
  controllers: [SeasonsController],
  providers:   [SeasonsService],
})
export class SeasonsModule {}
