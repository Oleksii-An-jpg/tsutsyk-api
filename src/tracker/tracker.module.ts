import { Module } from '@nestjs/common';
import { FirestoreModule } from '../firestore/firestore.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { GeofenceModule } from '../geofence/geofence.module';
import { TrackerController } from './tracker.controller';
import { TrackerResolvers } from './tracker.resolvers';
import { TrackerService } from './tracker.service';

@Module({
  providers: [TrackerResolvers, TrackerService],
  // ScheduleModule is registered once in AppModule; AlertsModule is @Global.
  imports: [FirestoreModule, NotificationsModule, GeofenceModule],
  controllers: [TrackerController],
})
export class TrackerModule {}
