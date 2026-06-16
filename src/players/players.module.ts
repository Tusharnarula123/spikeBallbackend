import { Module } from '@nestjs/common';
import { PlayersController } from './players.controller';
import { PlayersMeController } from './players-me.controller';
import { PlayersService } from './players.service';

@Module({
  controllers: [PlayersMeController, PlayersController],
  providers: [PlayersService],
  exports: [PlayersService],
})
export class PlayersModule {}
