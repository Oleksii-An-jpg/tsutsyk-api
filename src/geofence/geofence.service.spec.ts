import { Timestamp } from 'firebase-admin/firestore';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { GeofenceService } from './geofence.service';
import { FirestoreService } from '../firestore/firestore.service';
import { AlertAreaDoc, TsutsykDoc } from '../firestore/firestore.types';
import { NotificationsService } from '../notifications/notifications.service';

// ─── Just enough Firestore for one tracker and its areas ─────────────────

interface Ref<T> {
  id: string;
  get: () => Promise<{ exists: boolean; data: () => T; ref: Ref<T> }>;
  set: (patch: Partial<T>, opts?: unknown) => Promise<void>;
  delete: () => Promise<void>;
}

function fakeFirestore(tsutsyk: TsutsykDoc) {
  const tsutsyks = new Map<string, TsutsykDoc>([['t1', tsutsyk]]);
  const areas = new Map<string, AlertAreaDoc>();
  let nextId = 1;

  function ref<T>(store: Map<string, T>, id: string): Ref<T> {
    const self: Ref<T> = {
      id,
      get: () =>
        Promise.resolve({
          exists: store.has(id),
          data: () => store.get(id),
          ref: self,
        }),
      set: (patch) => {
        store.set(id, { ...store.get(id), ...patch });
        return Promise.resolve();
      },
      delete: () => {
        store.delete(id);
        return Promise.resolve();
      },
    };
    return self;
  }

  const snapshot = (filter: (doc: AlertAreaDoc) => boolean) => () => {
    const docs = [...areas.entries()]
      .filter(([, doc]) => filter(doc))
      .map(([id, doc]) => ({ id, data: () => doc }));
    return Promise.resolve({ docs, empty: docs.length === 0 });
  };

  const alertAreas = () => ({
    doc: (id?: string) => ref(areas, id ?? `a${nextId++}`),
    orderBy: () => ({ get: snapshot(() => true) }),
    count: () => ({
      get: () => Promise.resolve({ data: () => ({ count: areas.size }) }),
    }),
    where: () => {
      const get = snapshot((doc) => doc.enabled);
      return { get, limit: () => ({ get }) };
    },
  });

  type Gettable = { get: () => Promise<unknown> };
  type Settable = { set: (patch: unknown) => Promise<void> };
  const writes = () => {
    const pending: (() => Promise<void>)[] = [];
    return {
      pending,
      set: (target: Settable, patch: unknown) =>
        pending.push(() => target.set(patch)),
      delete: (target: { delete: () => Promise<void> }) =>
        pending.push(() => target.delete()),
    };
  };

  return {
    tsutsyks,
    areas,
    service: {
      tsutsyks: { doc: (id: string) => ref(tsutsyks, id) },
      alertAreas,
      db: {
        batch: () => {
          const w = writes();
          return {
            set: w.set,
            delete: w.delete,
            commit: async () => {
              for (const write of w.pending) await write();
            },
          };
        },
        runTransaction: async <R>(
          fn: (tx: unknown) => Promise<R>,
        ): Promise<R> => {
          const w = writes();
          const result = await fn({
            get: (target: Gettable) => target.get(),
            set: w.set,
          });
          for (const write of w.pending) await write();
          return result;
        },
      },
    } as unknown as FirestoreService,
  };
}

function fakeNotifications() {
  const sent: { uid: string; payload: { title: string; body: string } }[] = [];
  return {
    sent,
    service: {
      sendToUser: (uid: string, payload: { title: string; body: string }) => {
        sent.push({ uid, payload });
        return Promise.resolve(1);
      },
    } as unknown as NotificationsService,
  };
}

function claimedDoc(overrides: Partial<TsutsykDoc> = {}): TsutsykDoc {
  return {
    createdAt: Timestamp.now(),
    claimed: true,
    ownerUid: 'owner-1',
    name: 'Карематик',
    ...overrides,
  };
}

const YARD = [
  { lat: 46.46, lng: 30.54 },
  { lat: 46.46, lng: 30.5426 },
  { lat: 46.4618, lng: 30.5426 },
  { lat: 46.4618, lng: 30.54 },
];
const IN_YARD = { lat: 46.4609, lng: 30.5413 };
const FAR_AWAY = { lat: 46.4663, lng: 30.5413 };

function setup(doc = claimedDoc()) {
  const firestore = fakeFirestore(doc);
  const push = fakeNotifications();
  const geofence = new GeofenceService(firestore.service, push.service);
  return { ...firestore, push, geofence };
}

describe('GeofenceService', () => {
  describe('the exit alert', () => {
    it('tells the owner once when the tracker walks out', async () => {
      const { geofence, push } = setup();
      await geofence.createArea({
        uid: 'owner-1',
        tsutsykId: 't1',
        name: 'Двір',
        points: YARD,
      });

      await geofence.checkFix('t1', IN_YARD);
      expect(push.sent).toHaveLength(0);

      await geofence.checkFix('t1', FAR_AWAY);
      await geofence.checkFix('t1', FAR_AWAY);
      expect(push.sent).toHaveLength(1);
      expect(push.sent[0].uid).toBe('owner-1');
      expect(push.sent[0].payload.body).toContain('«Двір»');
      expect(push.sent[0].payload.title).toContain('Карематик');
    });

    it('starts over when the areas change', async () => {
      const { geofence, push, tsutsyks } = setup();
      const area = await geofence.createArea({
        uid: 'owner-1',
        tsutsykId: 't1',
        name: 'Двір',
        points: YARD,
      });
      await geofence.checkFix('t1', IN_YARD);
      expect(tsutsyks.get('t1')?.geofence).toEqual({
        inside: true,
        areaId: area.id,
      });

      await geofence.updateArea({
        uid: 'owner-1',
        tsutsykId: 't1',
        id: area.id,
        name: 'Подвір’я',
      });
      expect(tsutsyks.get('t1')?.geofence).toBeNull();

      // Out, but we never saw it in since the edit: no push.
      await geofence.checkFix('t1', FAR_AWAY);
      expect(push.sent).toHaveLength(0);
    });

    it('ignores a paused area', async () => {
      const { geofence, push } = setup();
      const area = await geofence.createArea({
        uid: 'owner-1',
        tsutsykId: 't1',
        name: 'Двір',
        points: YARD,
      });
      await geofence.checkFix('t1', IN_YARD);
      await geofence.updateArea({
        uid: 'owner-1',
        tsutsykId: 't1',
        id: area.id,
        enabled: false,
      });
      await geofence.checkFix('t1', IN_YARD);
      await geofence.checkFix('t1', FAR_AWAY);
      expect(push.sent).toHaveLength(0);
    });

    it('has nobody to tell about an unclaimed tracker', async () => {
      const { geofence, push, areas } = setup(claimedDoc({ ownerUid: null }));
      const now = Timestamp.now();
      areas.set('a1', {
        name: 'Двір',
        points: YARD,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
      await geofence.checkFix('t1', IN_YARD);
      await geofence.checkFix('t1', FAR_AWAY);
      expect(push.sent).toHaveLength(0);
    });

    it('never rejects, even when the push does', async () => {
      const firestore = fakeFirestore(claimedDoc());
      const geofence = new GeofenceService(firestore.service, {
        sendToUser: () => Promise.reject(new Error('push is down')),
      } as unknown as NotificationsService);
      await geofence.createArea({
        uid: 'owner-1',
        tsutsykId: 't1',
        name: 'Двір',
        points: YARD,
      });
      await geofence.checkFix('t1', IN_YARD);
      await expect(geofence.checkFix('t1', FAR_AWAY)).resolves.toBeUndefined();
    });
  });

  describe('saving an area', () => {
    it('refuses a stranger', async () => {
      const { geofence } = setup();
      await expect(
        geofence.createArea({
          uid: 'someone-else',
          tsutsykId: 't1',
          name: 'Двір',
          points: YARD,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        geofence.listAreas('someone-else', 't1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses a shape that is not a fence', async () => {
      const { geofence } = setup();
      const save = (points: { lat: number; lng: number }[], name = 'Двір') =>
        geofence.createArea({ uid: 'owner-1', tsutsykId: 't1', name, points });

      await expect(save(YARD.slice(0, 2))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      // Three taps on one spot.
      await expect(save([YARD[0], YARD[0], YARD[0]])).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(
        save([...YARD.slice(0, 3), { lat: 91, lng: 0 }]),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(save(YARD, '   ')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('stores only the coordinates it was given', async () => {
      const { geofence, areas } = setup();
      const area = await geofence.createArea({
        uid: 'owner-1',
        tsutsykId: 't1',
        name: '  Двір ',
        points: YARD.map((p) => ({ ...p, extra: 'nope' })),
      });
      expect(area.name).toBe('Двір');
      expect(areas.get(area.id)?.points[0]).toEqual(YARD[0]);
    });
  });
});
