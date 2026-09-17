import { AlertStatus } from '../alerts/alerts.service';

/** Why a tracker is being told to report at the cadence it is. */
export type ReportingReason = 'normal' | 'air_raid' | 'low_battery';

export interface ReportingPolicy {
  /** How often the device should send its next fixes, in seconds. */
  readonly intervalSeconds: number;
  readonly reason: ReportingReason;
}

/** The everyday cadence: often enough to follow a walk, cheap on battery. */
export const NORMAL_INTERVAL_SECONDS = 300;

/** The cadence while the tracker's oblast is under an air raid alert. */
export const ALERT_INTERVAL_SECONDS = 60;

/**
 * Below this we do not accelerate, alert or not.
 *
 * The fast cadence costs battery, and an alert can run for hours — long enough
 * to flatten a tracker that started the night low. A device still reporting
 * every five minutes is worth more than one that reported every minute until
 * it died, so the floor wins over the alert. The owner can see the battery and
 * make their own call; the tracker should not make it for them by going dark.
 */
export const LOW_BATTERY_PERCENT = 15;

export interface ReportingPolicyInput {
  readonly alertStatus: AlertStatus;
  /** Percent, or null when the device did not report one. */
  readonly batteryPercent?: number | null;
}

/**
 * Decides the cadence for one tracker.
 *
 * Pure and total: every input maps to a policy, because this answer rides back
 * on a device request that must not fail over a missing reading.
 *
 * `unknown` deliberately behaves like `no_alert` for cadence. We only ever
 * accelerate on a reading we can actually vouch for — an alerts.in.ua outage
 * must not put every tracker in the country onto the fast cadence at once.
 * (It is still not the same thing as quiet, and the UI says so.)
 */
export function resolveReportingPolicy({
  alertStatus,
  batteryPercent = null,
}: ReportingPolicyInput): ReportingPolicy {
  const alerted = alertStatus === 'active' || alertStatus === 'partly';
  if (!alerted) {
    return { intervalSeconds: NORMAL_INTERVAL_SECONDS, reason: 'normal' };
  }

  // A device that reports no battery reading still gets the alert cadence:
  // the alert is certain, the empty battery is only a possibility.
  if (batteryPercent !== null && batteryPercent < LOW_BATTERY_PERCENT) {
    return { intervalSeconds: NORMAL_INTERVAL_SECONDS, reason: 'low_battery' };
  }

  return { intervalSeconds: ALERT_INTERVAL_SECONDS, reason: 'air_raid' };
}

/**
 * Where the battery has to climb back to before we would warn about it again.
 *
 * A single threshold would flap: a tracker sitting at exactly 15% crosses it
 * a dozen times an afternoon as the reading wobbles, and each crossing would
 * be another notification. The gap between this and `LOW_BATTERY_PERCENT` is
 * what makes "it has been charged" a different event from "it is noisy".
 */
export const BATTERY_RECOVERED_PERCENT = 25;

/** What, if anything, a battery reading should change about the owner's state. */
export type BatteryEdge = 'notify' | 'clear' | 'none';

export interface BatteryEdgeInput {
  /** Percent, or null when the device did not report one. */
  readonly batteryPercent?: number | null;
  /** Whether the owner has already been told about this low battery. */
  readonly alreadyNotified: boolean;
}

/**
 * Decides whether a fix crosses the battery into or out of "tell the owner".
 *
 * Pure, and edge-triggered rather than level-triggered: a tracker reports
 * every five minutes, so warning on the level would be twelve notifications an
 * hour for as long as the battery stayed flat.
 *
 * A device that reports no battery at all changes nothing. It is not a
 * recovery, and it is not a reason to warn — plenty of fixes arrive without
 * one, and neither conclusion would be true.
 */
export function batteryEdge({
  batteryPercent = null,
  alreadyNotified,
}: BatteryEdgeInput): BatteryEdge {
  if (batteryPercent === null) return 'none';
  if (batteryPercent < LOW_BATTERY_PERCENT) {
    return alreadyNotified ? 'none' : 'notify';
  }
  if (batteryPercent >= BATTERY_RECOVERED_PERCENT && alreadyNotified) {
    return 'clear';
  }
  return 'none';
}
