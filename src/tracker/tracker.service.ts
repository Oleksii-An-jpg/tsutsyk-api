import { Injectable } from '@nestjs/common';
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
  Location as GqlLocation,
  Session as GqlSession,
  SessionStatus,
  Tsutsyk as GqlTsutsyk,
} from '../graphql.schema';

export const DEFAULT_ALERT_DISTANCE_METERS = 100;

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
  private readonly pubSub = new PubSub();
  constructor(private readonly firestore: FirestoreService) {}

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

    return gqlPoint;
  }

  private buildGqlTsutsyk(
    id: string,
    data: TsutsykDoc,
    sessions: GqlSession[],
  ): GqlTsutsyk {
    return {
      id,
      photoUrl: data.photoUrl ?? null,
      alertDistanceMeters:
        data.alertDistanceMeters ?? DEFAULT_ALERT_DISTANCE_METERS,
      sessions,
    };
  }

  async getTsutsyk(id: string): Promise<GqlTsutsyk | null> {
    const doc = await this.firestore.tsutsyks.doc(id).get();
    if (!doc.exists) return null;

    const sessions = await this.getTsutsykSessions(id);
    return this.buildGqlTsutsyk(id, doc.data(), sessions);
  }

  async updateTsutsyk({
    id,
    photoUrl,
    alertDistanceMeters,
  }: {
    id: string;
    photoUrl?: string | null;
    alertDistanceMeters?: number | null;
  }): Promise<GqlTsutsyk> {
    const tsutsykRef = this.firestore.tsutsyks.doc(id);

    const update: Partial<TsutsykDoc> = {};
    if (photoUrl !== undefined) update.photoUrl = photoUrl;
    if (alertDistanceMeters !== undefined)
      update.alertDistanceMeters = alertDistanceMeters;

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
        tx.set(tsutsykRef, { createdAt: now });
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
