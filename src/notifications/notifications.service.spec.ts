import { Logger } from '@nestjs/common';
import { Timestamp } from 'firebase-admin/firestore';
import webpush, { WebPushError } from 'web-push';
import {
  NotificationsService,
  PushPayload,
  isGone,
  subscriptionId,
} from './notifications.service';
import { FirestoreService } from '../firestore/firestore.service';
import { PushSubscriptionDoc } from '../firestore/firestore.types';

jest.mock('web-push', () => ({
  __esModule: true,
  default: {
    setVapidDetails: jest.fn(),
    sendNotification: jest.fn(),
  },
  WebPushError: class WebPushError extends Error {
    constructor(
      message: string,
      readonly statusCode: number,
    ) {
      super(message);
    }
  },
}));

const sendNotification = webpush.sendNotification as jest.Mock;
const setVapidDetails = webpush.setVapidDetails as jest.Mock;

// ─── Just enough Firestore for one collection ───────────────────────────
// Documents, one equality query, deletes and merge-less writes — which is all
// this service ever asks for.

function fakeFirestore(docs: Record<string, PushSubscriptionDoc> = {}) {
  const store = new Map(Object.entries(docs));

  const doc = (id: string) => ({
    get: () =>
      Promise.resolve({
        id,
        exists: store.has(id),
        data: () => store.get(id),
      }),
    set: (value: PushSubscriptionDoc) => {
      store.set(id, value);
      return Promise.resolve();
    },
    update: (patch: Partial<PushSubscriptionDoc>) => {
      const existing = store.get(id);
      if (existing) store.set(id, { ...existing, ...patch });
      return Promise.resolve();
    },
    delete: () => {
      store.delete(id);
      return Promise.resolve();
    },
  });

  return {
    store,
    service: {
      pushSubscriptions: {
        doc,
        where: (
          field: keyof PushSubscriptionDoc,
          _op: string,
          value: unknown,
        ) => ({
          get: () => {
            const matches = [...store.entries()].filter(
              ([, entry]) => entry[field] === value,
            );
            return Promise.resolve({
              empty: matches.length === 0,
              docs: matches.map(([id, entry]) => ({
                id,
                data: () => entry,
              })),
            });
          },
        }),
      },
    } as unknown as FirestoreService,
  };
}

function subscriptionDoc(
  overrides: Partial<PushSubscriptionDoc> = {},
): PushSubscriptionDoc {
  return {
    ownerUid: 'owner-1',
    endpoint: 'https://push.example/one',
    keys: { p256dh: 'p', auth: 'a' },
    createdAt: Timestamp.now(),
    lastSeenAt: Timestamp.now(),
    userAgent: null,
    ...overrides,
  };
}

describe('NotificationsService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      VAPID_PUBLIC_KEY: 'public-key',
      VAPID_PRIVATE_KEY: 'private-key',
    };
    jest.clearAllMocks();
    sendNotification.mockResolvedValue(undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  describe('without VAPID keys', () => {
    beforeEach(() => {
      delete process.env.VAPID_PUBLIC_KEY;
      delete process.env.VAPID_PRIVATE_KEY;
    });

    it('stands down rather than failing', async () => {
      const { service } = fakeFirestore({
        [subscriptionId('https://push.example/one')]: subscriptionDoc(),
      });
      const notifications = new NotificationsService(service);

      expect(notifications.enabled).toBe(false);
      expect(notifications.getPublicKey()).toBeNull();
      expect(setVapidDetails).not.toHaveBeenCalled();

      await expect(
        notifications.sendToUser('owner-1', { title: 't', body: 'b' }),
      ).resolves.toBe(0);
      expect(sendNotification).not.toHaveBeenCalled();
    });

    // The toggle still has to work: keys can be configured later, and a
    // subscription taken before that should not have to be taken again.
    it('still stores subscriptions', async () => {
      const { store, service } = fakeFirestore();
      const notifications = new NotificationsService(service);

      await notifications.saveSubscription({
        uid: 'owner-1',
        subscription: {
          endpoint: 'https://push.example/one',
          keys: { p256dh: 'p', auth: 'a' },
        },
      });

      expect(store.size).toBe(1);
    });
  });

  describe('saveSubscription', () => {
    it('files the subscription under the caller', async () => {
      const { store, service } = fakeFirestore();
      const notifications = new NotificationsService(service);

      await notifications.saveSubscription({
        uid: 'owner-1',
        subscription: {
          endpoint: 'https://push.example/one',
          keys: { p256dh: 'p', auth: 'a' },
        },
        userAgent: 'Firefox',
      });

      const stored = store.get(subscriptionId('https://push.example/one'));
      expect(stored.ownerUid).toBe('owner-1');
      expect(stored.keys).toEqual({ p256dh: 'p', auth: 'a' });
      expect(stored.userAgent).toBe('Firefox');
    });

    // Re-subscribing is routine — the browser does it on its own schedule.
    // Landing on a second document would leave the first to fail forever.
    it('overwrites rather than duplicating the same endpoint', async () => {
      const { store, service } = fakeFirestore();
      const notifications = new NotificationsService(service);
      const subscription = {
        endpoint: 'https://push.example/one',
        keys: { p256dh: 'p', auth: 'a' },
      };

      await notifications.saveSubscription({ uid: 'owner-1', subscription });
      const first = store.get(subscriptionId(subscription.endpoint)).createdAt;

      await notifications.saveSubscription({
        uid: 'owner-1',
        subscription: { ...subscription, keys: { p256dh: 'p2', auth: 'a2' } },
      });

      expect(store.size).toBe(1);
      const stored = store.get(subscriptionId(subscription.endpoint));
      expect(stored.keys).toEqual({ p256dh: 'p2', auth: 'a2' });
      expect(stored.createdAt).toBe(first);
    });

    // Push services do recycle endpoints. The new owner gets a clean record
    // rather than inheriting the old one's creation date.
    it('starts over when an endpoint changes hands', async () => {
      const endpoint = 'https://push.example/one';
      const { store, service } = fakeFirestore({
        [subscriptionId(endpoint)]: subscriptionDoc({
          ownerUid: 'owner-1',
          createdAt: Timestamp.fromMillis(1),
        }),
      });
      const notifications = new NotificationsService(service);

      await notifications.saveSubscription({
        uid: 'owner-2',
        subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } },
      });

      const stored = store.get(subscriptionId(endpoint));
      expect(stored.ownerUid).toBe('owner-2');
      expect(stored.createdAt.toMillis()).not.toBe(1);
    });

    it('truncates an absurd user agent', async () => {
      const { store, service } = fakeFirestore();
      const notifications = new NotificationsService(service);

      await notifications.saveSubscription({
        uid: 'owner-1',
        subscription: {
          endpoint: 'https://push.example/one',
          keys: { p256dh: 'p', auth: 'a' },
        },
        userAgent: 'x'.repeat(5000),
      });

      expect(
        store.get(subscriptionId('https://push.example/one')).userAgent,
      ).toHaveLength(256);
    });
  });

  describe('deleteSubscription', () => {
    it('forgets the caller’s own subscription', async () => {
      const endpoint = 'https://push.example/one';
      const { store, service } = fakeFirestore({
        [subscriptionId(endpoint)]: subscriptionDoc({ ownerUid: 'owner-1' }),
      });
      const notifications = new NotificationsService(service);

      await notifications.deleteSubscription({ uid: 'owner-1', endpoint });

      expect(store.size).toBe(0);
    });

    // The endpoint comes from the client. Without the ownership check, anyone
    // holding someone else's endpoint could silence them.
    it('refuses to unsubscribe somebody else', async () => {
      const endpoint = 'https://push.example/one';
      const { store, service } = fakeFirestore({
        [subscriptionId(endpoint)]: subscriptionDoc({ ownerUid: 'owner-1' }),
      });
      const notifications = new NotificationsService(service);

      await notifications.deleteSubscription({ uid: 'owner-2', endpoint });

      expect(store.size).toBe(1);
    });

    it('is quiet about an endpoint it never had', async () => {
      const { service } = fakeFirestore();
      const notifications = new NotificationsService(service);

      await expect(
        notifications.deleteSubscription({
          uid: 'owner-1',
          endpoint: 'https://push.example/missing',
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('sendToUser', () => {
    it('pushes to every browser the owner has', async () => {
      const { service } = fakeFirestore({
        [subscriptionId('https://push.example/one')]: subscriptionDoc({
          endpoint: 'https://push.example/one',
        }),
        [subscriptionId('https://push.example/two')]: subscriptionDoc({
          endpoint: 'https://push.example/two',
        }),
        [subscriptionId('https://push.example/other')]: subscriptionDoc({
          ownerUid: 'owner-2',
          endpoint: 'https://push.example/other',
        }),
      });
      const notifications = new NotificationsService(service);

      const sent = await notifications.sendToUser('owner-1', {
        title: 'Повітряна тривога',
        body: 'Київська область — тривога.',
      });

      expect(sent).toBe(2);
      expect(sendNotification).toHaveBeenCalledTimes(2);
      const [, body] = sendNotification.mock.calls[0] as [unknown, string];
      const payload = JSON.parse(body) as PushPayload;
      expect(payload.title).toBe('Повітряна тривога');
    });

    it('answers zero for somebody who never subscribed', async () => {
      const { service } = fakeFirestore();
      const notifications = new NotificationsService(service);

      await expect(
        notifications.sendToUser('owner-1', { title: 't', body: 'b' }),
      ).resolves.toBe(0);
      expect(sendNotification).not.toHaveBeenCalled();
    });

    // 404/410 is the push service saying this browser is gone for good.
    it.each([404, 410])(
      'prunes an endpoint the service reports %i',
      async (statusCode) => {
        const { store, service } = fakeFirestore({
          [subscriptionId('https://push.example/one')]: subscriptionDoc(),
        });
        const notifications = new NotificationsService(service);
        sendNotification.mockRejectedValue(
          new WebPushError('gone', statusCode),
        );

        const sent = await notifications.sendToUser('owner-1', {
          title: 't',
          body: 'b',
        });

        expect(sent).toBe(0);
        expect(store.size).toBe(0);
      },
    );

    // A 500 is the push service having a bad minute, not a dead browser.
    it('keeps an endpoint that failed for a passing reason', async () => {
      const { store, service } = fakeFirestore({
        [subscriptionId('https://push.example/one')]: subscriptionDoc(),
      });
      const notifications = new NotificationsService(service);
      sendNotification.mockRejectedValue(new WebPushError('oops', 500));

      await expect(
        notifications.sendToUser('owner-1', { title: 't', body: 'b' }),
      ).resolves.toBe(0);
      expect(store.size).toBe(1);
    });

    // Callers are a device posting a fix and an alert poll. Neither should
    // fail because a push service did.
    it('never throws', async () => {
      const { service } = fakeFirestore({
        [subscriptionId('https://push.example/one')]: subscriptionDoc(),
      });
      const notifications = new NotificationsService(service);
      sendNotification.mockRejectedValue(new Error('socket hang up'));

      await expect(
        notifications.sendToUser('owner-1', { title: 't', body: 'b' }),
      ).resolves.toBe(0);
    });

    it('one bad endpoint does not stop the others', async () => {
      const { service } = fakeFirestore({
        [subscriptionId('https://push.example/one')]: subscriptionDoc({
          endpoint: 'https://push.example/one',
        }),
        [subscriptionId('https://push.example/two')]: subscriptionDoc({
          endpoint: 'https://push.example/two',
        }),
      });
      const notifications = new NotificationsService(service);
      sendNotification
        .mockRejectedValueOnce(new WebPushError('gone', 410))
        .mockResolvedValueOnce(undefined);

      await expect(
        notifications.sendToUser('owner-1', { title: 't', body: 'b' }),
      ).resolves.toBe(1);
    });
  });

  describe('sendToUsers', () => {
    it('counts every delivery and repeats nobody', async () => {
      const { service } = fakeFirestore({
        [subscriptionId('https://push.example/one')]: subscriptionDoc({
          ownerUid: 'owner-1',
          endpoint: 'https://push.example/one',
        }),
        [subscriptionId('https://push.example/two')]: subscriptionDoc({
          ownerUid: 'owner-2',
          endpoint: 'https://push.example/two',
        }),
      });
      const notifications = new NotificationsService(service);

      const sent = await notifications.sendToUsers(
        ['owner-1', 'owner-2', 'owner-1'],
        { title: 't', body: 'b' },
      );

      expect(sent).toBe(2);
      expect(sendNotification).toHaveBeenCalledTimes(2);
    });
  });

  describe('subscriptionId', () => {
    it('is stable and endpoint-specific', () => {
      expect(subscriptionId('https://push.example/one')).toBe(
        subscriptionId('https://push.example/one'),
      );
      expect(subscriptionId('https://push.example/one')).not.toBe(
        subscriptionId('https://push.example/two'),
      );
    });

    // Endpoints are URLs; Firestore document ids may not contain a slash.
    it('produces a usable document id', () => {
      expect(subscriptionId('https://push.example/a/b?c=d')).toMatch(
        /^[0-9a-f]{64}$/,
      );
    });
  });

  describe('isGone', () => {
    it.each([
      [404, true],
      [410, true],
      [400, false],
      [429, false],
      [500, false],
    ])('%i -> %s', (statusCode, expected) => {
      expect(isGone(statusCode)).toBe(expected);
    });
  });
});
