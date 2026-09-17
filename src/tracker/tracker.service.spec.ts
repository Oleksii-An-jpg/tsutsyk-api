import { Timestamp } from 'firebase-admin/firestore';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { TrackerService } from './tracker.service';
import { FirestoreService } from '../firestore/firestore.service';
import { AlertsService, AlertStatus } from '../alerts/alerts.service';
import { TsutsykDoc } from '../firestore/firestore.types';
import { AirRaidStatus } from '../graphql.schema';
import {
  NORMAL_INTERVAL_SECONDS,
  ALERT_INTERVAL_SECONDS,
} from './reporting-policy';

// ─── Just enough Firestore for the tsutsyks collection ──────────────────
// The region wiring only ever touches one document and never queries, so a
// full fake (see orders.service.spec.ts) would be noise here.

const KYIV_UID = 31;
const LVIV_UID = 27;
/** alerts.in.ua knows this uid, but as a raion — the oblast feed has no slot for it. */
const BORYSPIL_RAION_UID = 78;

function fakeFirestore(docs: Record<string, TsutsykDoc>) {
  const store = new Map(Object.entries(docs));
  return {
    store,
    service: {
      tsutsyks: {
        doc: (id: string) => ({
          get: () =>
            Promise.resolve({
              exists: store.has(id),
              data: () => store.get(id),
            }),
          set: (patch: Partial<TsutsykDoc>) => {
            store.set(id, { ...store.get(id), ...patch });
            return Promise.resolve();
          },
        }),
      },
      // No sessions in these fixtures; buildGqlTsutsyk still asks for them.
      sessions: {
        where: () => ({
          orderBy: () => ({ get: () => Promise.resolve({ docs: [] }) }),
        }),
      },
    } as unknown as FirestoreService,
  };
}

function fakeAlerts(statuses: Record<number, AlertStatus> = {}) {
  return {
    getStatus: (uid?: number | null) =>
      uid == null ? 'unknown' : (statuses[uid] ?? 'no_alert'),
  } as unknown as AlertsService;
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

describe('TrackerService — air raid region', () => {
  describe('updateTsutsyk', () => {
    it('stores a region the alert feed actually carries', async () => {
      const { store, service } = fakeFirestore({ t1: claimedDoc() });
      const tracker = new TrackerService(service, fakeAlerts());

      const result = await tracker.updateTsutsyk({
        id: 't1',
        uid: 'owner-1',
        alertRegionUid: KYIV_UID,
      });

      expect(store.get('t1')?.alertRegionUid).toBe(KYIV_UID);
      expect(result.alertRegion).toEqual({ uid: KYIV_UID, title: 'м. Київ' });
    });

    // Storing a uid we cannot follow would look like the feature is on while
    // it silently never fires — the worst of both.
    it.each([
      ['a raion uid', BORYSPIL_RAION_UID],
      ['a uid that does not exist', 9999],
      ['zero', 0],
    ])('refuses %s', async (_label, alertRegionUid) => {
      const { store, service } = fakeFirestore({ t1: claimedDoc() });
      const tracker = new TrackerService(service, fakeAlerts());

      await expect(
        tracker.updateTsutsyk({ id: 't1', uid: 'owner-1', alertRegionUid }),
      ).rejects.toThrow(BadRequestException);
      expect(store.get('t1')?.alertRegionUid).toBeUndefined();
    });

    it('clears the region when passed null', async () => {
      const { store, service } = fakeFirestore({
        t1: claimedDoc({ alertRegionUid: KYIV_UID }),
      });
      const tracker = new TrackerService(service, fakeAlerts());

      const result = await tracker.updateTsutsyk({
        id: 't1',
        uid: 'owner-1',
        alertRegionUid: null,
      });

      expect(store.get('t1')?.alertRegionUid).toBeNull();
      expect(result.alertRegion).toBeNull();
      expect(result.airRaidStatus).toBe(AirRaidStatus.UNKNOWN);
    });

    it('leaves the region alone when the field is omitted', async () => {
      const { store, service } = fakeFirestore({
        t1: claimedDoc({ alertRegionUid: LVIV_UID }),
      });
      const tracker = new TrackerService(service, fakeAlerts());

      await tracker.updateTsutsyk({
        id: 't1',
        uid: 'owner-1',
        photoUrl: '/p.jpg',
      });

      expect(store.get('t1')?.alertRegionUid).toBe(LVIV_UID);
    });

    it('still refuses a stranger', async () => {
      const { service } = fakeFirestore({ t1: claimedDoc() });
      const tracker = new TrackerService(service, fakeAlerts());

      await expect(
        tracker.updateTsutsyk({
          id: 't1',
          uid: 'someone-else',
          alertRegionUid: KYIV_UID,
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('the status on the tracker', () => {
    it.each([
      ['active' as const, AirRaidStatus.ACTIVE],
      ['partly' as const, AirRaidStatus.PARTLY],
      ['no_alert' as const, AirRaidStatus.NO_ALERT],
      ['unknown' as const, AirRaidStatus.UNKNOWN],
    ])('reports %s as %s', async (status, expected) => {
      const { service } = fakeFirestore({
        t1: claimedDoc({ alertRegionUid: KYIV_UID }),
      });
      const tracker = new TrackerService(
        service,
        fakeAlerts({ [KYIV_UID]: status }),
      );

      expect((await tracker.getTsutsyk('t1'))?.airRaidStatus).toBe(expected);
    });

    it('reads a region it no longer recognises as no region at all', async () => {
      const { service } = fakeFirestore({
        t1: claimedDoc({ alertRegionUid: 9999 }),
      });
      const tracker = new TrackerService(service, fakeAlerts());

      const result = await tracker.getTsutsyk('t1');
      expect(result?.alertRegion).toBeNull();
      expect(result?.airRaidStatus).toBe(AirRaidStatus.UNKNOWN);
    });
  });

  describe('resolveReportingPolicyFor', () => {
    it('accelerates a tracker whose oblast is under an alert', async () => {
      const { service } = fakeFirestore({
        t1: claimedDoc({ alertRegionUid: KYIV_UID }),
      });
      const tracker = new TrackerService(
        service,
        fakeAlerts({ [KYIV_UID]: 'active' }),
      );

      await expect(
        tracker.resolveReportingPolicyFor('t1', 80),
      ).resolves.toEqual({
        policy: { intervalSeconds: ALERT_INTERVAL_SECONDS, reason: 'air_raid' },
        alertStatus: 'active',
      });
    });

    it('leaves a tracker in a quiet oblast alone', async () => {
      const { service } = fakeFirestore({
        t1: claimedDoc({ alertRegionUid: LVIV_UID }),
      });
      const tracker = new TrackerService(
        service,
        fakeAlerts({ [KYIV_UID]: 'active' }),
      );

      const { policy } = await tracker.resolveReportingPolicyFor('t1', 80);
      expect(policy.intervalSeconds).toBe(NORMAL_INTERVAL_SECONDS);
    });

    it('answers for a tracker with no region set', async () => {
      const { service } = fakeFirestore({ t1: claimedDoc() });
      const tracker = new TrackerService(service, fakeAlerts());

      await expect(
        tracker.resolveReportingPolicyFor('t1', 80),
      ).resolves.toEqual({
        policy: { intervalSeconds: NORMAL_INTERVAL_SECONDS, reason: 'normal' },
        alertStatus: 'unknown',
      });
    });

    // A fix from a unit we have no document for still has to get an answer:
    // refusing would leave it with no cadence at all.
    it('answers for a tracker it has never seen', async () => {
      const { service } = fakeFirestore({});
      const tracker = new TrackerService(service, fakeAlerts());

      const { policy } = await tracker.resolveReportingPolicyFor('ghost', null);
      expect(policy).toEqual({
        intervalSeconds: NORMAL_INTERVAL_SECONDS,
        reason: 'normal',
      });
    });
  });
});
