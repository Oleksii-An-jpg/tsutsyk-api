import { Module } from '@nestjs/common';
import { FirestoreModule } from '../firestore/firestore.module';
import { TrackerResolvers } from './tracker.resolvers';
import { TrackerService } from './tracker.service';

@Module({
  providers: [TrackerResolvers, TrackerService],
  // ScheduleModule is registered once in AppModule.
  imports: [FirestoreModule],
  controllers: [],
})
export class TrackerModule {}
