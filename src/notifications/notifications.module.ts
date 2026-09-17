import { Module } from '@nestjs/common';
import { FirestoreModule } from '../firestore/firestore.module';
import { AirRaidNotifier } from './air-raid.notifier';
import { NotificationsResolvers } from './notifications.resolvers';
import { NotificationsService } from './notifications.service';

/**
 * Web Push: storing who to reach, and reaching them.
 *
 * Exported because the things worth pushing are noticed elsewhere — a flat
 * battery by the tracker, a raised alert by the poller — and each of those
 * wants to hand a message to one place that knows how to deliver it.
 */
@Module({
  // AlertsModule is @Global, so AirRaidNotifier can inject AlertsService here.
  imports: [FirestoreModule],
  providers: [NotificationsService, NotificationsResolvers, AirRaidNotifier],
  exports: [NotificationsService],
})
export class NotificationsModule {}
