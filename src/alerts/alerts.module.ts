import { Global, Module } from '@nestjs/common';
import { AlertsService } from './alerts.service';

/**
 * Air raid alert state, shared process-wide.
 *
 * Global because the poller is a singleton by nature — one request serves the
 * whole country — and more than one instance would multiply our rate-limit
 * footprint for no gain.
 */
@Global()
@Module({
  providers: [AlertsService],
  exports: [AlertsService],
})
export class AlertsModule {}
