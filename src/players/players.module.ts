import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { PlayersController } from './players.controller';
import { PlayersMeController } from './players-me.controller';
import { PlayersService } from './players.service';

@Module({
  imports: [MulterModule.register({ storage: memoryStorage() })],
  controllers: [PlayersMeController, PlayersController],
  providers: [PlayersService],
  exports: [PlayersService],
})
export class PlayersModule {}
