import { Module } from '@nestjs/common';
import { FirestoreModule } from '../firestore/firestore.module';
import { TrackerResolvers } from './tracker.resolvers';
import { TrackerService } from './tracker.service';
import { ScheduleModule } from '@nestjs/schedule';

@Module({
  providers: [TrackerResolvers, TrackerService],
  imports: [FirestoreModule, ScheduleModule.forRoot()],
  controllers: [],
})
export class TrackerModule {}
