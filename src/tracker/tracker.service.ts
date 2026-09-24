import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
// import { Cron, CronExpression } from '@nestjs/schedule';
import { PubSub } from 'graphql-subscriptions';
import { QueryDocumentSnapshot, Timestamp } from 'firebase-admin/firestore';
import { FirestoreService } from '../firestore/firestore.service';
import {
  TsutsykDoc,
  SessionDoc,
  LocationDoc,
} from '../firestore/firestore.types';
import {
  AirRaidStatus,
  AlertRegion as GqlAlertRegion,
  Location as GqlLocation,
  Session as GqlSession,
  SessionStatus,
  Tsutsyk as GqlTsutsyk,
  TsutsykPublicProfile as GqlTsutsykPublicProfile,
} from '../graphql.schema';
import { AlertStatus, AlertsService } from '../alerts/alerts.service';
import { OBLASTS, findOblast, isKnownOblastUid } from '../alerts/oblasts';
import {
  ReportingPolicy,
  batteryEdge,
  resolveReportingPolicy,
} from './reporting-policy';
import { NotificationsService } from '../notifications/notifications.service';
import { GeofenceService } from '../geofence/geofence.service';

export const DEFAULT_ALERT_DISTANCE_METERS = 100;

/** Our internal alert vocabulary, as the schema spells it. */
const AIR_RAID_STATUS: Readonly<Record<AlertStatus, AirRaidStatus>> = {
  active: AirRaidStatus.ACTIVE,
  partly: AirRaidStatus.PARTLY,
  no_alert: AirRaidStatus.NO_ALERT,
  unknown: AirRaidStatus.UNKNOWN,
};

interface RawLocation {
  id: string;
  sessionId: string;
  latitude: number;
  longitude: number;
  battery: number | null;
  timestamp: Date;
}

@Injectable()
export class TrackerService {
  private readonly logger = new Logger(TrackerService.name);
  private readonly pubSub = new PubSub();
  constructor(
    private readonly firestore: FirestoreService,
    private readonly alerts: AlertsService,
    private readonly notifications: NotificationsService,
    private readonly geofence: GeofenceService,
  ) {}

  private toRawLocation(
    sessionId: string,
    doc: QueryDocumentSnapshot<LocationDoc>,
  ): RawLocation {
    const data = doc.data();
    return {
      id: doc.id,
      sessionId,
      latitude: data.latitude,
      longitude: data.longitude,
      battery: data.battery,
      timestamp: data.timestamp.toDate(),
    };
  }

  private toGqlLocation(raw: RawLocation): GqlLocation {
    return { ...raw, timestamp: raw.timestamp.toISOString() };
  }

  private async fetchLocations(
    sessionId: string,
    opts?: { desc?: boolean; limit?: number },
  ): Promise<RawLocation[]> {
    let query = this.firestore
      .sessionLocations(sessionId)
      .orderBy('timestamp', opts?.desc ? 'desc' : 'asc');

    if (opts?.limit) {
      query = query.limit(opts.limit);
    }

    const snapshot = await query.get();
    return snapshot.docs.map((doc) => this.toRawLocation(sessionId, doc));
  }

  private buildGqlSession(
    id: string,
    data: SessionDoc,
    locations: RawLocation[],
    locationCount: number,
  ): GqlSession {
    return {
      id,
      tsutsykId: data.tsutsykId,
      startTime: data.startTime.toDate().toISOString(),
      endTime: data.endTime ? data.endTime.toDate().toISOString() : null,
      status: data.status,
      locationCount,
      locations: locations.map((l) => this.toGqlLocation(l)),
    };
  }

  async recordSingleLocation({
    sessionId,
    tsutsykId,
    lat,
    lng,
    battery,
  }: {
    tsutsykId: string;
    sessionId: string;
    lat: number;
    lng: number;
    battery?: number;
  }): Promise<GqlLocation> {
    // 1. Auto-create session if it doesn't exist (plug-and-play!)
    await this.ensureSessionExists(tsutsykId, sessionId);

    // 2. Create the location point
    const now = Timestamp.now();
    const locationRef = this.firestore.sessionLocations(sessionId).doc();
    const locationData: LocationDoc = {
      latitude: lat,
      longitude: lng,
      battery: battery ?? null,
      timestamp: now,
    };

    await Promise.all([
      locationRef.set(locationData),
      this.firestore.sessions.doc(sessionId).update({ lastLocationAt: now }),
    ]);

    const gqlPoint = this.toGqlLocation({
      id: locationRef.id,
      sessionId,
      latitude: locationData.latitude,
      longitude: locationData.longitude,
      battery: locationData.battery,
      timestamp: now.toDate(),
    });

    // 3. Publish to subscribers
    await this.pubSub.publish('locationUpdates', { locationUpdates: gqlPoint });

    // 4. Has it left its alert areas? Detached for the same reason as the
    // battery warning: the device is waiting on this request, and must not
    // wait on a push service. `checkFix` never rejects.
    void this.geofence.checkFix(tsutsykId, { lat, lng });

    return gqlPoint;
  }

  private buildGqlTsutsyk(
    id: string,
    data: TsutsykDoc,
    sessions: GqlSession[],
  ): GqlTsutsyk {
    // A uid we no longer recognise (alerts.in.ua retired it, or the doc was
    // hand-edited) reads as no region at all rather than as a silent zero:
    // better an owner who can see the picker is unset than one who thinks
    // their tracker is watching a region it is not.
    const oblast =
      data.alertRegionUid != null ? findOblast(data.alertRegionUid) : undefined;

    return {
      id,
      name: data.name ?? null,
      photoUrl: data.photoUrl ?? null,
      claimed: data.claimed,
      alertDistanceMeters:
        data.alertDistanceMeters ?? DEFAULT_ALERT_DISTANCE_METERS,
      alertRegion: oblast ? { uid: oblast.uid, title: oblast.title } : null,
      airRaidStatus: AIR_RAID_STATUS[this.alerts.getStatus(oblast?.uid)],
      sessions,
    };
  }

  /** The oblast list behind the owner's region picker. */
  listAlertRegions(): GqlAlertRegion[] {
    return OBLASTS.map(({ uid, title }) => ({ uid, title }));
  }

  /**
   * The cadence a given tracker should currently be reporting at.
   *
   * Reads the tracker's chosen oblast and asks the alert feed about it. A
   * tracker we have never seen, or one with no region set, gets the everyday
   * cadence — an unknown device is not a reason to refuse an answer, since the
   * answer is what keeps it reporting at all.
   */
  async resolveReportingPolicyFor(
    tsutsykId: string,
    batteryPercent: number | null,
  ): Promise<{ policy: ReportingPolicy; alertStatus: AlertStatus }> {
    const doc = await this.firestore.tsutsyks.doc(tsutsykId).get();
    const data = doc.exists ? doc.data() : null;
    const regionUid = data?.alertRegionUid ?? null;
    const alertStatus = this.alerts.getStatus(regionUid);

    // The low-battery warning is settled here because this is the one place
    // on the device path that already holds both halves — the tracker
    // document and the reading — and a tracker on a marginal signal is paying
    // for every millisecond this request stays open. Deliberately not
    // awaited: the device's answer is its next reporting interval, and it
    // must not wait on a push service to get it.
    if (data) {
      void this.settleBatteryWarning(tsutsykId, data, batteryPercent);
    }

    return {
      policy: resolveReportingPolicy({ alertStatus, batteryPercent }),
      alertStatus,
    };
  }

  /**
   * Warns the owner the first time a battery goes low, and re-arms the warning
   * once it has been charged.
   *
   * Never throws and never rejects: it runs detached from the fix that
   * triggered it, so an unhandled rejection here would be an unhandled
   * rejection in the process.
   */
  private async settleBatteryWarning(
    tsutsykId: string,
    data: TsutsykDoc,
    batteryPercent: number | null,
  ): Promise<void> {
    try {
      const edge = batteryEdge({
        batteryPercent,
        alreadyNotified: data.lowBatteryNotified ?? false,
      });
      if (edge === 'none') return;

      await this.firestore.tsutsyks
        .doc(tsutsykId)
        .set({ lowBatteryNotified: edge === 'notify' }, { merge: true });

      // Only the falling edge is worth a notification. A tracker coming back
      // off the charger is good news, and good news at 3am is still 3am.
      if (edge !== 'notify' || !data.ownerUid) return;

      await this.notifications.sendToUser(data.ownerUid, {
        title: 'Цуцик розряджається',
        body: `${data.name || 'Цуцик'} — ${batteryPercent}% заряду. Час на зарядку.`,
        url: '/me',
        tag: `low-battery-${tsutsykId}`,
      });
    } catch (error) {
      this.logger.warn(
        `low battery warning for ${tsutsykId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async getTsutsyk(id: string): Promise<GqlTsutsyk | null> {
    const doc = await this.firestore.tsutsyks.doc(id).get();
    if (!doc.exists) return null;

    const sessions = await this.getTsutsykSessions(id);
    return this.buildGqlTsutsyk(id, doc.data(), sessions);
  }

  // Public, unauthenticated lookup for the tsutsyk.live/tsutsyk/<id> landing
  // page. Deliberately returns only name/photo/claimed — never sessions —
  // since this can be called by anyone who scans the QR code.
  async getTsutsykPublicProfile(
    id: string,
  ): Promise<GqlTsutsykPublicProfile | null> {
    const doc = await this.firestore.tsutsyks.doc(id).get();
    if (!doc.exists) return null;

    const data = doc.data();
    return {
      id,
      claimed: data.claimed,
      name: data.name ?? null,
      photoUrl: data.photoUrl ?? null,
    };
  }

  async getMyTsutsyks(uid: string): Promise<GqlTsutsyk[]> {
    const snapshot = await this.firestore.tsutsyks
      .where('ownerUid', '==', uid)
      .get();

    return Promise.all(
      snapshot.docs.map(async (doc) => {
        const sessions = await this.getTsutsykSessions(doc.id);
        return this.buildGqlTsutsyk(doc.id, doc.data(), sessions);
      }),
    );
  }

  // First-scan onboarding: atomically claims an unclaimed (or not-yet-
  // provisioned) Tsutsyk for the caller. Runs in a transaction so two
  // simultaneous scans of the same fresh unit can't both "win".
  async claimTsutsyk({
    id,
    uid,
    name,
    photoUrl,
  }: {
    id: string;
    uid: string;
    name: string;
    photoUrl?: string | null;
  }): Promise<GqlTsutsyk> {
    const tsutsykRef = this.firestore.tsutsyks.doc(id);

    await this.firestore.db.runTransaction(async (tx) => {
      const snap = await tx.get(tsutsykRef);

      if (snap.exists && snap.data().claimed) {
        throw new ConflictException('This Tsutsyk has already been claimed');
      }

      const now = Timestamp.now();
      const update: Partial<TsutsykDoc> = {
        claimed: true,
        ownerUid: uid,
        name,
        claimedAt: now,
      };
      if (photoUrl !== undefined) update.photoUrl = photoUrl;

      if (snap.exists) {
        tx.set(tsutsykRef, update, { merge: true });
      } else {
        tx.set(tsutsykRef, { ...update, createdAt: now } as TsutsykDoc);
      }
    });

    const [doc, sessions] = await Promise.all([
      tsutsykRef.get(),
      this.getTsutsykSessions(id),
    ]);

    return this.buildGqlTsutsyk(id, doc.data(), sessions);
  }

  async updateTsutsyk({
    id,
    uid,
    photoUrl,
    alertDistanceMeters,
    alertRegionUid,
  }: {
    id: string;
    uid: string;
    photoUrl?: string | null;
    alertDistanceMeters?: number | null;
    alertRegionUid?: number | null;
  }): Promise<GqlTsutsyk> {
    const tsutsykRef = this.firestore.tsutsyks.doc(id);

    const existing = await tsutsykRef.get();
    if (!existing.exists || existing.data().ownerUid !== uid) {
      throw new ForbiddenException('You do not own this Tsutsyk');
    }

    const update: Partial<TsutsykDoc> = {};
    if (photoUrl !== undefined) update.photoUrl = photoUrl;
    if (alertDistanceMeters !== undefined)
      update.alertDistanceMeters = alertDistanceMeters;
    if (alertRegionUid !== undefined) {
      // Refuse a uid we cannot follow rather than storing it and quietly
      // never raising an alert for it. A raion uid is the likely mistake:
      // alerts.in.ua knows it, but the oblast feed does not carry it.
      if (alertRegionUid !== null && !isKnownOblastUid(alertRegionUid)) {
        throw new BadRequestException(
          `${alertRegionUid} is not one of the regions in getAlertRegions`,
        );
      }
      update.alertRegionUid = alertRegionUid;
    }

    await tsutsykRef.set(update, { merge: true });

    const [doc, sessions] = await Promise.all([
      tsutsykRef.get(),
      this.getTsutsykSessions(id),
    ]);

    return this.buildGqlTsutsyk(id, doc.data(), sessions);
  }

  async ensureSessionExists(tsutsykId: string, sessionId: string) {
    const sessionRef = this.firestore.sessions.doc(sessionId);
    const tsutsykRef = this.firestore.tsutsyks.doc(tsutsykId);

    await this.firestore.db.runTransaction(async (tx) => {
      const existing = await tx.get(sessionRef);
      if (existing.exists) return; // already created, nothing to do

      const [tsutsykSnap, activeSessions] = await Promise.all([
        tx.get(tsutsykRef),
        tx.get(
          this.firestore.sessions
            .where('tsutsykId', '==', tsutsykId)
            .where('status', '==', SessionStatus.ACTIVE),
        ),
      ]);

      const now = Timestamp.now();

      // New session — close any other active ones first
      for (const doc of activeSessions.docs) {
        tx.update(doc.ref, {
          status: SessionStatus.COMPLETED,
          endTime: now,
        });
      }

      if (!tsutsykSnap.exists) {
        tx.set(tsutsykRef, { createdAt: now, claimed: false });
      }

      const newSession: SessionDoc = {
        tsutsykId,
        startTime: now,
        endTime: null,
        status: SessionStatus.ACTIVE,
        lastLocationAt: null,
      };
      tx.set(sessionRef, newSession);
    });
  }

  async getTsutsykSessions(tsutsykId: string): Promise<GqlSession[]> {
    const snapshot = await this.firestore.sessions
      .where('tsutsykId', '==', tsutsykId)
      .orderBy('startTime', 'desc')
      .get();

    return Promise.all(
      snapshot.docs.map(async (doc) => {
        const data = doc.data();
        const locations = await this.fetchLocations(doc.id);
        return this.buildGqlSession(doc.id, data, locations, locations.length);
      }),
    );
  }

  async getSession(sessionId: string): Promise<GqlSession | null> {
    const doc = await this.firestore.sessions.doc(sessionId).get();
    if (!doc.exists) return null;

    const locations = await this.fetchLocations(sessionId);
    return this.buildGqlSession(
      doc.id,
      doc.data(),
      locations,
      locations.length,
    );
  }

  async getActiveSession(tsutsykId: string): Promise<GqlSession | null> {
    const snapshot = await this.firestore.sessions
      .where('tsutsykId', '==', tsutsykId)
      .where('status', '==', SessionStatus.ACTIVE)
      .orderBy('startTime', 'desc')
      .limit(1)
      .get();

    if (snapshot.empty) return null;

    const [doc] = snapshot.docs;
    const locationsRef = this.firestore.sessionLocations(doc.id);

    const [latestLocation, countSnapshot] = await Promise.all([
      this.fetchLocations(doc.id, { desc: true, limit: 1 }),
      locationsRef.count().get(),
    ]);

    return this.buildGqlSession(
      doc.id,
      doc.data(),
      latestLocation,
      countSnapshot.data().count,
    );
  }

  async endSession(sessionId: string): Promise<GqlSession> {
    const sessionRef = this.firestore.sessions.doc(sessionId);
    const now = Timestamp.now();

    await sessionRef.update({
      status: SessionStatus.COMPLETED,
      endTime: now,
    });

    const doc = await sessionRef.get();
    const locations = await this.fetchLocations(sessionId);

    return this.buildGqlSession(
      doc.id,
      doc.data(),
      locations,
      locations.length,
    );
  }

  // Existing methods...
  async getLocationHistory(sessionId: string): Promise<RawLocation[]> {
    return this.fetchLocations(sessionId);
  }

  async autoEndInactiveSessions() {
    const thresholdMinutes = 30; // No updates for 30 minutes = auto-end
    const threshold = new Date();
    threshold.setMinutes(threshold.getMinutes() - thresholdMinutes);

    // Find active sessions whose last known location is older than the threshold
    const inactiveSessions = await this.firestore.sessions
      .where('status', '==', SessionStatus.ACTIVE)
      .where('lastLocationAt', '<', Timestamp.fromDate(threshold))
      .get();

    // End each inactive session
    const now = Timestamp.now();
    for (const doc of inactiveSessions.docs) {
      await doc.ref.update({
        status: SessionStatus.COMPLETED,
        endTime: now,
      });

      console.log(`Auto-ended inactive session: ${doc.id}`);
    }

    return inactiveSessions.size;
  }

  // @Cron(CronExpression.EVERY_5_MINUTES)
  // async handleInactiveSessions() {
  //   const count = await this.autoEndInactiveSessions();
  //   if (count > 0) {
  //     console.log(`Auto-ended ${count} inactive sessions`);
  //   }
  // }

  getPubSub() {
    return this.pubSub;
  }
}
