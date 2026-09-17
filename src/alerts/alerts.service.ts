import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { OBLAST_COUNT, OBLASTS, Oblast, findOblast } from './oblasts';

/**
 * What we believe about one oblast right now.
 *
 * `unknown` is a real answer, not a placeholder: it means we cannot currently
 * vouch for the alert state, and callers must not render it as "no alert".
 */
export type AlertStatus = 'active' | 'partly' | 'no_alert' | 'unknown';

/** The characters alerts.in.ua packs into the IoT status string. */
const STATUS_BY_CHAR: Readonly<Record<string, AlertStatus>> = {
  A: 'active',
  P: 'partly',
  N: 'no_alert',
  // A space marks a uid alerts.in.ua has not assigned to a region.
  ' ': 'unknown',
};

const DEFAULT_API_BASE = 'https://api.alerts.in.ua';
const ENDPOINT = '/v1/iot/active_air_raid_alerts_by_oblast.json';

/** The official client's own timeout. A slow answer is a missing answer. */
const REQUEST_TIMEOUT_MS = 5_000;

const DEFAULT_POLL_INTERVAL_MS = 30_000;

/**
 * How long a successful poll stays trustworthy. Past this we stop claiming to
 * know anything, rather than serving a stale reading as fact.
 */
const DEFAULT_STALE_AFTER_MS = 180_000;

/**
 * How long a *raised* alert survives losing contact with alerts.in.ua.
 *
 * Staleness is not symmetric. Forgetting a quiet oblast costs nothing. But if
 * the feed drops out while an alert is up, snapping straight back to the slow
 * cadence would withdraw the feature exactly during the emergency it exists
 * for — so a known-active oblast holds its status for this long before it
 * decays to `unknown`.
 */
const DEFAULT_HOLD_MS = 600_000;

/**
 * One oblast crossing into or out of an alert, as of a fresh reading.
 *
 * Emitted only for a poll that actually came back with data. Losing contact
 * with alerts.in.ua decays a reading to `unknown`, which is not an all-clear
 * and must never be announced as one.
 */
export interface AlertTransition {
  readonly uid: number;
  readonly status: AlertStatus;
  /** True when the alert was just raised, false when it was just lifted. */
  readonly alerted: boolean;
}

export type AlertTransitionListener = (
  transitions: readonly AlertTransition[],
) => void;

interface Snapshot {
  readonly statuses: ReadonlyMap<number, AlertStatus>;
  /** When we last *confirmed* this reading — a 304 counts, it means "still current". */
  readonly confirmedAt: number;
}

/**
 * Parses the positional IoT status string into a status per oblast uid.
 *
 * Throws on a malformed payload rather than silently mapping the tail to
 * `no_alert`: a short string would quietly mark late-alphabet oblasts as quiet,
 * which is the one failure mode this whole feature must never have.
 */
export function parseOblastStatuses(raw: unknown): Map<number, AlertStatus> {
  if (typeof raw !== 'string') {
    throw new Error(`expected a status string, got ${typeof raw}`);
  }
  if (raw.length !== OBLAST_COUNT) {
    throw new Error(
      `expected ${OBLAST_COUNT} oblast statuses, got ${raw.length}`,
    );
  }

  const statuses = new Map<number, AlertStatus>();
  for (const oblast of OBLASTS) {
    const char = raw[oblast.index];
    const status = STATUS_BY_CHAR[char];
    if (status === undefined) {
      throw new Error(
        `unrecognised status ${JSON.stringify(char)} at index ${oblast.index}`,
      );
    }
    statuses.set(oblast.uid, status);
  }
  return statuses;
}

/**
 * Air raid alert state, polled from alerts.in.ua.
 *
 * One poller serves every tracker: the IoT endpoint returns the whole country
 * in 27 bytes, so per-device polling would buy nothing and cost rate limit.
 *
 * Without `ALERTS_IN_UA_TOKEN` the service stands down — every oblast reads
 * `unknown` and the rest of the API runs untouched, the same way the orders
 * module behaves without a monobank token.
 */
@Injectable()
export class AlertsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AlertsService.name);

  private readonly token = process.env.ALERTS_IN_UA_TOKEN?.trim() || null;
  private readonly apiBase = (
    process.env.ALERTS_API_BASE || DEFAULT_API_BASE
  ).replace(/\/+$/, '');
  private readonly pollIntervalMs = readMs(
    'ALERTS_POLL_INTERVAL_MS',
    DEFAULT_POLL_INTERVAL_MS,
  );
  private readonly staleAfterMs = readMs(
    'ALERTS_STALE_AFTER_MS',
    DEFAULT_STALE_AFTER_MS,
  );
  private readonly holdMs = readMs('ALERTS_HOLD_MS', DEFAULT_HOLD_MS);

  private snapshot: Snapshot | null = null;
  /**
   * Whether each oblast was alerted as of the last reading we actually got.
   *
   * Separate from `snapshot` because it is an edge detector, not a cache: it
   * only ever moves on a successful poll, so a feed outage produces no
   * transitions rather than a countryside's worth of false all-clears.
   */
  private readonly alerted = new Map<number, boolean>();
  private readonly listeners = new Set<AlertTransitionListener>();
  private lastModified: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** Set by a 429 so we stop hammering a feed that has asked us not to. */
  private backoffUntil = 0;

  get enabled(): boolean {
    return this.token !== null;
  }

  onModuleInit() {
    if (!this.enabled) {
      this.logger.warn(
        'ALERTS_IN_UA_TOKEN is not set — air raid alert cadence is off and every oblast reads "unknown"',
      );
      return;
    }
    // A plain interval rather than @Cron: the poll is sub-minute and its
    // period is configurable, neither of which a cron expression expresses.
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
    // Never hold the process open for a poll.
    this.timer.unref?.();
    void this.poll();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * The current status for one oblast uid, with staleness and the hold window
   * already applied. Callers get a straight answer or `unknown`; they never
   * have to reason about how old the reading is.
   */
  getStatus(uid: number | null | undefined, now = Date.now()): AlertStatus {
    if (uid == null || !this.snapshot) return 'unknown';
    if (findOblast(uid) === undefined) return 'unknown';

    const status = this.snapshot.statuses.get(uid) ?? 'unknown';
    const age = now - this.snapshot.confirmedAt;

    if (age <= this.staleAfterMs) return status;
    // Past the freshness window a raised alert still stands for a while; a
    // quiet oblast simply stops being something we know.
    if ((status === 'active' || status === 'partly') && age <= this.holdMs) {
      return status;
    }
    return 'unknown';
  }

  /** Whether an oblast is under an alert of any kind. `unknown` is not. */
  isAlerted(uid: number | null | undefined, now = Date.now()): boolean {
    const status = this.getStatus(uid, now);
    return status === 'active' || status === 'partly';
  }

  /**
   * Registers a listener for alerts being raised and lifted.
   *
   * @returns an unsubscribe function.
   */
  onTransition(listener: AlertTransitionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Exposed for the health/debug surface and for tests. */
  getSnapshotAge(now = Date.now()): number | null {
    return this.snapshot ? now - this.snapshot.confirmedAt : null;
  }

  /**
   * One poll. Public so tests can drive it without waiting on a timer.
   * Never throws: a failed poll leaves the previous snapshot in place and lets
   * the staleness rules decide what it is still worth.
   */
  async poll(now = Date.now()): Promise<void> {
    if (!this.token) return;
    if (now < this.backoffUntil) return;

    try {
      const response = await this.request();

      if (response.status === 304) {
        // Unchanged, but freshly confirmed — the reading is current again.
        if (this.snapshot) {
          this.snapshot = { ...this.snapshot, confirmedAt: Date.now() };
        }
        return;
      }

      if (!response.ok) {
        this.handleErrorStatus(response.status);
        return;
      }

      const statuses = parseOblastStatuses(await response.json());
      this.snapshot = { statuses, confirmedAt: Date.now() };
      this.lastModified = response.headers.get('Last-Modified');
      this.backoffUntil = 0;
      this.emitTransitions(statuses);
    } catch (error) {
      // Includes a parse failure: a payload we cannot read is worse than no
      // payload, so we keep the last good snapshot and let it age out.
      this.logger.warn(
        `air raid alert poll failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Compares a fresh reading against the last one and tells anyone listening
   * which oblasts changed.
   *
   * The very first reading of a process seeds the baseline silently. Without
   * that, every restart during an alert would re-announce it to every owner in
   * the oblast — a deploy is not a siren.
   */
  private emitTransitions(statuses: ReadonlyMap<number, AlertStatus>): void {
    const seeding = this.alerted.size === 0;
    const transitions: AlertTransition[] = [];

    for (const [uid, status] of statuses) {
      const alerted = status === 'active' || status === 'partly';
      const before = this.alerted.get(uid);
      this.alerted.set(uid, alerted);
      if (!seeding && before !== alerted) {
        transitions.push({ uid, status, alerted });
      }
    }

    if (seeding || transitions.length === 0) return;

    for (const listener of this.listeners) {
      try {
        listener(transitions);
      } catch (error) {
        // A listener that throws is its own problem: the poller's job is to
        // keep polling, and the next reading must not be lost to it.
        this.logger.warn(
          `alert transition listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async request(): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.token}`,
      'User-Agent': 'tsutsyk/1.0 (+https://tsutsyk.live)',
    };
    if (this.lastModified) headers['If-Modified-Since'] = this.lastModified;

    return fetch(`${this.apiBase}${ENDPOINT}`, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  private handleErrorStatus(status: number): void {
    if (status === 429) {
      // Back off for ten polls rather than the usual one, and stop asking.
      this.backoffUntil = Date.now() + this.pollIntervalMs * 10;
      this.logger.warn('alerts.in.ua rate limited us — backing off');
      return;
    }
    if (status === 401) {
      this.logger.error('alerts.in.ua rejected ALERTS_IN_UA_TOKEN (401)');
      return;
    }
    if (status === 403) {
      this.logger.error(
        'alerts.in.ua returned 403 — the API is not available from this region or plan',
      );
      return;
    }
    this.logger.warn(`alerts.in.ua answered ${status}`);
  }
}

/** Reads a positive integer of milliseconds from the environment. */
function readMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export type { Oblast };
