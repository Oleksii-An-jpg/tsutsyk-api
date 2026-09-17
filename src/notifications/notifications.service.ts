import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { Timestamp } from 'firebase-admin/firestore';
import webpush, { WebPushError } from 'web-push';
import { FirestoreService } from '../firestore/firestore.service';
import { PushSubscriptionDoc } from '../firestore/firestore.types';

/** What the service worker in the storefront expects to find in `event.data`. */
export interface PushPayload {
  title: string;
  body: string;
  /**
   * Where a tap should land. The service worker opens this, so it is a path
   * on the storefront rather than an absolute URL.
   */
  url?: string;
  /**
   * Notifications sharing a tag replace each other instead of stacking. Two
   * "тривога" banners for the same dog is one banner and one annoyance.
   */
  tag?: string;
}

/** The half of a PushSubscription the browser hands us. */
export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const DEFAULT_SUBJECT = 'mailto:voodoo.spr@gmail.com';

/**
 * An endpoint is a URL, and Firestore document ids may not contain `/`. The
 * hash is also what makes re-subscribing idempotent: the same browser always
 * lands on the same document instead of leaving a trail of dead endpoints for
 * us to keep pushing at.
 */
export function subscriptionId(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex');
}

/**
 * Web Push, owned by the API because the API is what learns things.
 *
 * The storefront can only notice something while somebody is looking at it;
 * an air raid alert or a flat battery happens whether or not anyone has the
 * tab open, and this is the process that hears about both.
 *
 * Without VAPID keys the service stands down: subscriptions are still stored,
 * every send is a no-op, and the rest of the API runs untouched — the same
 * posture the orders module takes without a monobank token.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  private readonly publicKey = process.env.VAPID_PUBLIC_KEY?.trim() || null;
  private readonly privateKey = process.env.VAPID_PRIVATE_KEY?.trim() || null;

  constructor(private readonly firestore: FirestoreService) {
    if (this.enabled) {
      webpush.setVapidDetails(
        process.env.VAPID_SUBJECT?.trim() || DEFAULT_SUBJECT,
        this.publicKey,
        this.privateKey,
      );
    } else {
      this.logger.warn(
        'VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY are not set — push notifications are off',
      );
    }
  }

  get enabled(): boolean {
    return this.publicKey !== null && this.privateKey !== null;
  }

  /**
   * The key a browser needs to call `pushManager.subscribe`.
   *
   * Served rather than configured on the storefront as well, so the two halves
   * of one keypair cannot drift apart. A public key that does not match the
   * private one signing the request fails at the push service, per device,
   * with nothing in our logs to say why.
   */
  getPublicKey(): string | null {
    return this.publicKey;
  }

  /**
   * Stores one browser's subscription, or refreshes it if we already had it.
   *
   * Takes the uid from the verified token, never from the client, so a
   * subscription can only ever be filed under the person who created it.
   */
  async saveSubscription({
    uid,
    subscription,
    userAgent,
  }: {
    uid: string;
    subscription: PushSubscriptionInput;
    userAgent?: string | null;
  }): Promise<void> {
    const now = Timestamp.now();
    const ref = this.firestore.pushSubscriptions.doc(
      subscriptionId(subscription.endpoint),
    );

    const existing = await ref.get();
    const doc: PushSubscriptionDoc = {
      ownerUid: uid,
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      // A browser that re-subscribes keeps its original creation time; one
      // whose endpoint was recycled to another account starts over.
      createdAt:
        existing.exists && existing.data().ownerUid === uid
          ? existing.data().createdAt
          : now,
      lastSeenAt: now,
      userAgent: userAgent?.slice(0, 256) ?? null,
    };

    await ref.set(doc);
  }

  /**
   * Forgets one browser's subscription.
   *
   * Ownership is checked rather than assumed: the endpoint arrives from the
   * client, and without the check anyone holding someone else's endpoint could
   * quietly turn their notifications off.
   */
  async deleteSubscription({
    uid,
    endpoint,
  }: {
    uid: string;
    endpoint: string;
  }): Promise<void> {
    const ref = this.firestore.pushSubscriptions.doc(subscriptionId(endpoint));
    const existing = await ref.get();
    if (!existing.exists || existing.data().ownerUid !== uid) return;
    await ref.delete();
  }

  /**
   * Pushes to every browser one person has subscribed.
   *
   * Never throws. Every caller is some other piece of work — a device posting
   * a fix, an alert poll — and none of them should fail because a push service
   * was having a bad minute.
   *
   * @returns how many endpoints accepted the push.
   */
  async sendToUser(uid: string, payload: PushPayload): Promise<number> {
    if (!this.enabled) return 0;

    const snapshot = await this.firestore.pushSubscriptions
      .where('ownerUid', '==', uid)
      .get();
    if (snapshot.empty) return 0;

    const results = await Promise.all(
      snapshot.docs.map((doc) => this.deliver(doc.id, doc.data(), payload)),
    );
    return results.filter(Boolean).length;
  }

  /** The same, for several people at once. */
  async sendToUsers(uids: string[], payload: PushPayload): Promise<number> {
    const unique = [...new Set(uids)];
    const counts = await Promise.all(
      unique.map((uid) => this.sendToUser(uid, payload)),
    );
    return counts.reduce((total, count) => total + count, 0);
  }

  /** One endpoint. Prunes it when the push service says it is gone. */
  private async deliver(
    id: string,
    doc: PushSubscriptionDoc,
    payload: PushPayload,
  ): Promise<boolean> {
    try {
      await webpush.sendNotification(
        { endpoint: doc.endpoint, keys: doc.keys },
        JSON.stringify(payload),
      );
      await this.firestore.pushSubscriptions
        .doc(id)
        .update({ lastSeenAt: Timestamp.now() });
      return true;
    } catch (error) {
      // 404/410 is the push service telling us this browser is gone for good
      // — uninstalled, permission revoked, profile wiped. Keeping it would
      // mean paying for a failing request on every future send.
      if (error instanceof WebPushError && isGone(error.statusCode)) {
        await this.firestore.pushSubscriptions
          .doc(id)
          .delete()
          .catch(() => undefined);
        return false;
      }
      this.logger.warn(
        `push to ${doc.ownerUid} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}

/** Whether a push service's rejection means "never try this endpoint again". */
export function isGone(statusCode: number): boolean {
  return statusCode === 404 || statusCode === 410;
}
