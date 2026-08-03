import { Module } from '@nestjs/common';
import { FirestoreModule } from '../firestore/firestore.module';
import { TrackerModule } from '../tracker/tracker.module';
import { GadgetsController } from './gadgets.controller';
import { GadgetsService } from './gadgets.service';
import { GadgetsResolver } from './gadgets.resolver';

@Module({
  imports: [FirestoreModule, TrackerModule],
  controllers: [GadgetsController],
  providers: [GadgetsService, GadgetsResolver],
})
export class GadgetsModule {}
