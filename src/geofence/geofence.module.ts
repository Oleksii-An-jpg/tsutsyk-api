import { Module } from '@nestjs/common';
import { FirestoreModule } from '../firestore/firestore.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { GeofenceResolvers } from './geofence.resolvers';
import { GeofenceService } from './geofence.service';

/**
 * Alert areas. Exported because the fixes it checks arrive through the
 * tracker module, which hands each one over as it lands.
 */
@Module({
  imports: [FirestoreModule, NotificationsModule],
  providers: [GeofenceService, GeofenceResolvers],
  exports: [GeofenceService],
})
export class GeofenceModule {}
