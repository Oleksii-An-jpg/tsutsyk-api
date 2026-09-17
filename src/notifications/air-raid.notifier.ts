import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { AlertTransition, AlertsService } from '../alerts/alerts.service';
import { findOblast } from '../alerts/oblasts';
import { FirestoreService } from '../firestore/firestore.service';
import { NotificationsService, PushPayload } from './notifications.service';

/**
 * Tells owners when their tracker's oblast goes under an air raid alert, and
 * when it comes back out.
 *
 * The device already learns this — it is why the cadence changes — but nothing
 * told the person. This is the other half of that feature, and it is the half
 * that matters at four in the morning.
 *
 * It lives here rather than in AlertsService so the poller keeps knowing
 * nothing about Firestore or push: it announces a transition, and who cares
 * about that is somebody else's problem.
 */
@Injectable()
export class AirRaidNotifier implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AirRaidNotifier.name);
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly alerts: AlertsService,
    private readonly firestore: FirestoreService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    this.unsubscribe = this.alerts.onTransition((transitions) => {
      // The poller is not waiting on us, and it must not be: a push that
      // fails is not a reason to lose a reading.
      void this.handle(transitions).catch((error: unknown) => {
        this.logger.error(
          `air raid notifications failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      });
    });
  }

  onModuleDestroy() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Public so a test can drive it without a poll. */
  async handle(transitions: readonly AlertTransition[]): Promise<void> {
    if (!this.notifications.enabled) return;

    for (const transition of transitions) {
      const uids = await this.ownersFollowing(transition.uid);
      if (uids.length === 0) continue;

      await this.notifications.sendToUsers(uids, payloadFor(transition));
      this.logger.log(
        `air raid ${transition.alerted ? 'raised' : 'lifted'} in ${transition.uid}: notified ${uids.length} owner(s)`,
      );
    }
  }

  /**
   * The owners of claimed trackers pointed at one oblast.
   *
   * Filtered down to claimed-and-owned in code rather than in the query: the
   * extra `where` clauses would need a composite index for a collection whose
   * region filter already narrows it to a handful of documents.
   */
  private async ownersFollowing(regionUid: number): Promise<string[]> {
    const snapshot = await this.firestore.tsutsyks
      .where('alertRegionUid', '==', regionUid)
      .get();

    const uids = snapshot.docs
      .map((doc) => doc.data())
      .filter((doc) => doc.claimed && doc.ownerUid)
      .map((doc) => doc.ownerUid);

    return [...new Set(uids)];
  }
}

/** What one transition says to the people following that oblast. */
export function payloadFor(transition: AlertTransition): PushPayload {
  const title = findOblast(transition.uid)?.title ?? 'Ваш регіон';
  // One tag per oblast, so an all-clear replaces the alert it cancels rather
  // than sitting underneath it in the shade.
  const tag = `air-raid-${transition.uid}`;

  if (!transition.alerted) {
    return {
      title: 'Відбій тривоги',
      body: `${title} — відбій. Цуцик повертається до звичайних оновлень.`,
      url: '/me',
      tag,
    };
  }

  return {
    title: 'Повітряна тривога',
    body:
      transition.status === 'partly'
        ? `${title} — тривога в частині області. Цуцик оновлюється щохвилини.`
        : `${title} — тривога. Цуцик оновлюється щохвилини.`,
    url: '/me',
    tag,
  };
}
