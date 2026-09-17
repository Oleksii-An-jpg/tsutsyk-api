import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpException,
  Logger,
  Param,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { TrackerService } from './tracker.service';
import { AlertStatus } from '../alerts/alerts.service';
import { ReportingPolicy } from './reporting-policy';

/** What a tracker sends up with each fix. */
interface DeviceLocationBody {
  sessionId?: unknown;
  lat?: unknown;
  lng?: unknown;
  battery?: unknown;
}

/** What it gets back — the fix is acknowledged, and the cadence comes with it. */
interface DeviceLocationResponse {
  locationId: string;
  /** What the device should do next. The whole point of the response. */
  reporting: ReportingPolicy;
  /** Why, so a unit with an LED or a log can say something useful. */
  airRaid: AlertStatus;
}

const MAX_BATTERY_PERCENT = 100;

/**
 * Device ingest — and the only channel we have for talking *to* a tracker.
 *
 * The device posts a fix and the answer carries its reporting policy. That
 * pairing is the design: a Cat-1 modem's battery cost is dominated by radio
 * time, so a downlink that rides on a request the tracker was already making
 * is free, where polling a config endpoint or holding MQTT open is not. It
 * also means the cadence can only ever change as fast as the device checks in
 * — an alert raised at T is picked up at the tracker's next report, which is
 * the trade we are making for the battery.
 *
 * Auth is the tracker id in the path, matching the existing `postLocation`
 * mutation: the ids are 10 characters of unguessable alphabet and are not
 * published anywhere but the unit itself. That is thin — anyone who reads a
 * QR code off a collar can write points for that dog — and it is a
 * pre-existing property of the ingest path, not something this endpoint
 * introduces. Worth fixing with a per-device secret at provisioning time;
 * see the README.
 */
@Controller('tracker')
export class TrackerController {
  private readonly logger = new Logger(TrackerController.name);

  constructor(private readonly tracker: TrackerService) {}

  @Post(':tsutsykId/location')
  @HttpCode(200)
  async postLocation(
    @Param('tsutsykId') tsutsykId: string,
    @Body() body: DeviceLocationBody,
  ): Promise<DeviceLocationResponse> {
    const { sessionId, lat, lng, battery } = parseBody(body);

    // The policy lookup does not depend on the write, so it does not wait for
    // it: a tracker on a marginal signal is paying for every millisecond the
    // connection stays open. `recordSingleLocation` publishes to the
    // websocket subscribers itself, so there is nothing to fan out here.
    let point: Awaited<ReturnType<TrackerService['recordSingleLocation']>>;
    let resolved: Awaited<
      ReturnType<TrackerService['resolveReportingPolicyFor']>
    >;
    try {
      [point, resolved] = await Promise.all([
        this.tracker.recordSingleLocation({
          tsutsykId,
          sessionId,
          lat,
          lng,
          battery: battery ?? undefined,
        }),
        this.tracker.resolveReportingPolicyFor(tsutsykId, battery),
      ]);
    } catch (error) {
      // A session that belongs to another tracker is the device's mistake and
      // retrying will not help, so those answer for themselves. Everything
      // else is ours: 503 so the device retries the fix, keeping whatever
      // cadence it is already on until one succeeds.
      if (error instanceof HttpException) throw error;
      this.logger.error(`failed to record a fix for ${tsutsykId}`, error);
      throw new ServiceUnavailableException('Could not record the location');
    }

    return {
      locationId: point.id,
      reporting: resolved.policy,
      airRaid: resolved.alertStatus,
    };
  }
}

/**
 * Validates the body by hand, the way the monobank webhook does — there is no
 * global ValidationPipe in this app, and adding one would change how every
 * other endpoint answers.
 */
function parseBody(body: DeviceLocationBody): {
  sessionId: string;
  lat: number;
  lng: number;
  battery: number | null;
} {
  const sessionId =
    typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
  if (!sessionId) {
    throw new BadRequestException('sessionId is required');
  }

  const lat = coordinate(body?.lat, 'lat', 90);
  const lng = coordinate(body?.lng, 'lng', 180);

  let battery: number | null = null;
  if (body?.battery !== undefined && body?.battery !== null) {
    if (
      typeof body.battery !== 'number' ||
      !Number.isFinite(body.battery) ||
      body.battery < 0 ||
      body.battery > MAX_BATTERY_PERCENT
    ) {
      throw new BadRequestException(
        'battery must be a percentage from 0 to 100',
      );
    }
    battery = body.battery;
  }

  return { sessionId, lat, lng, battery };
}

function coordinate(value: unknown, name: string, limit: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BadRequestException(`${name} must be a number`);
  }
  if (value < -limit || value > limit) {
    throw new BadRequestException(
      `${name} must be between -${limit} and ${limit}`,
    );
  }
  return value;
}
