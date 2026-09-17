import { Logger } from '@nestjs/common';
import { Timestamp } from 'firebase-admin/firestore';
import { AirRaidNotifier, payloadFor } from './air-raid.notifier';
import { NotificationsService } from './notifications.service';
import { AlertsService, AlertTransition } from '../alerts/alerts.service';
import { findOblast } from '../alerts/oblasts';
import { FirestoreService } from '../firestore/firestore.service';
import { TsutsykDoc } from '../firestore/firestore.types';

const KYIV = 31;
const LVIV = 27;

function tsutsyk(overrides: Partial<TsutsykDoc> = {}): TsutsykDoc {
  return {
    createdAt: Timestamp.now(),
    claimed: true,
    ownerUid: 'owner-1',
    name: 'Карематик',
    alertRegionUid: KYIV,
    ...overrides,
  };
}

function fakeFirestore(docs: Record<string, TsutsykDoc>) {
  const store = new Map(Object.entries(docs));
  return {
    tsutsyks: {
      where: (field: keyof TsutsykDoc, _op: string, value: unknown) => ({
        get: () =>
          Promise.resolve({
            docs: [...store.entries()]
              .filter(([, doc]) => doc[field] === value)
              .map(([id, doc]) => ({ id, data: () => doc })),
          }),
      }),
    },
  } as unknown as FirestoreService;
}

function fakeNotifications(enabled = true) {
  const sent: { uids: string[]; payload: unknown }[] = [];
  return {
    sent,
    service: {
      enabled,
      sendToUsers: (uids: string[], payload: unknown) => {
        sent.push({ uids, payload });
        return Promise.resolve(uids.length);
      },
    } as unknown as NotificationsService,
  };
}

/** An AlertsService that only remembers the listener it was handed. */
function fakeAlerts() {
  let listener: ((t: readonly AlertTransition[]) => void) | null = null;
  return {
    emit: (transitions: AlertTransition[]) => listener?.(transitions),
    get registered() {
      return listener !== null;
    },
    service: {
      onTransition: (fn: (t: readonly AlertTransition[]) => void) => {
        listener = fn;
        return () => {
          listener = null;
        };
      },
    } as unknown as AlertsService,
  };
}

const raised: AlertTransition = {
  uid: KYIV,
  status: 'active',
  alerted: true,
};

describe('AirRaidNotifier', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('notifies the owners of trackers following that oblast', async () => {
    const { sent, service: notifications } = fakeNotifications();
    const notifier = new AirRaidNotifier(
      fakeAlerts().service,
      fakeFirestore({
        a: tsutsyk({ ownerUid: 'owner-1' }),
        b: tsutsyk({ ownerUid: 'owner-2' }),
      }),
      notifications,
    );

    await notifier.handle([raised]);

    expect(sent).toHaveLength(1);
    expect(sent[0].uids.sort()).toEqual(['owner-1', 'owner-2']);
  });

  it('leaves other oblasts alone', async () => {
    const { sent, service: notifications } = fakeNotifications();
    const notifier = new AirRaidNotifier(
      fakeAlerts().service,
      fakeFirestore({
        a: tsutsyk({ alertRegionUid: LVIV, ownerUid: 'owner-lviv' }),
      }),
      notifications,
    );

    await notifier.handle([raised]);

    expect(sent).toEqual([]);
  });

  // One person, two dogs, one oblast — that is one siren, not two.
  it('tells an owner with two trackers once', async () => {
    const { sent, service: notifications } = fakeNotifications();
    const notifier = new AirRaidNotifier(
      fakeAlerts().service,
      fakeFirestore({ a: tsutsyk(), b: tsutsyk() }),
      notifications,
    );

    await notifier.handle([raised]);

    expect(sent[0].uids).toEqual(['owner-1']);
  });

  // An unclaimed unit on a shelf has nobody to tell.
  it('skips unclaimed and unowned trackers', async () => {
    const { sent, service: notifications } = fakeNotifications();
    const notifier = new AirRaidNotifier(
      fakeAlerts().service,
      fakeFirestore({
        shelf: tsutsyk({ claimed: false, ownerUid: null }),
        orphan: tsutsyk({ claimed: true, ownerUid: null }),
      }),
      notifications,
    );

    await notifier.handle([raised]);

    expect(sent).toEqual([]);
  });

  it('stands down when push is not configured', async () => {
    const { sent, service: notifications } = fakeNotifications(false);
    const notifier = new AirRaidNotifier(
      fakeAlerts().service,
      fakeFirestore({ a: tsutsyk() }),
      notifications,
    );

    await notifier.handle([raised]);

    expect(sent).toEqual([]);
  });

  it('handles several oblasts moving at once', async () => {
    const { sent, service: notifications } = fakeNotifications();
    const notifier = new AirRaidNotifier(
      fakeAlerts().service,
      fakeFirestore({
        a: tsutsyk({ alertRegionUid: KYIV, ownerUid: 'owner-kyiv' }),
        b: tsutsyk({ alertRegionUid: LVIV, ownerUid: 'owner-lviv' }),
      }),
      notifications,
    );

    await notifier.handle([
      raised,
      { uid: LVIV, status: 'partly', alerted: true },
    ]);

    expect(sent.map((s) => s.uids)).toEqual([['owner-kyiv'], ['owner-lviv']]);
  });

  it('subscribes on init and lets go on destroy', () => {
    const alerts = fakeAlerts();
    const notifier = new AirRaidNotifier(
      alerts.service,
      fakeFirestore({}),
      fakeNotifications().service,
    );

    notifier.onModuleInit();
    expect(alerts.registered).toBe(true);

    notifier.onModuleDestroy();
    expect(alerts.registered).toBe(false);
  });
});

describe('payloadFor', () => {
  it('names the oblast that is under alert', () => {
    const payload = payloadFor(raised);
    expect(payload.title).toBe('Повітряна тривога');
    expect(payload.body).toContain(findOblast(KYIV).title);
  });

  it('says so when only part of the oblast is alerted', () => {
    expect(
      payloadFor({ uid: KYIV, status: 'partly', alerted: true }).body,
    ).toContain('частині');
  });

  it('announces an all-clear as an all-clear', () => {
    const payload = payloadFor({
      uid: KYIV,
      status: 'no_alert',
      alerted: false,
    });
    expect(payload.title).toBe('Відбій тривоги');
  });

  // Shared tag, so the all-clear replaces the alert instead of stacking.
  it('tags both halves of one oblast the same', () => {
    expect(payloadFor(raised).tag).toBe(
      payloadFor({ uid: KYIV, status: 'no_alert', alerted: false }).tag,
    );
  });

  it('survives a uid that is no longer an oblast', () => {
    const payload = payloadFor({ uid: 9999, status: 'active', alerted: true });
    expect(payload.body).toContain('Ваш регіон');
  });
});
