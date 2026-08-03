import {
  DocumentData,
  FirestoreDataConverter,
  QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import { LocationDoc, SessionDoc, TsutsykDoc } from './firestore.types';

export const tsutsykConverter: FirestoreDataConverter<TsutsykDoc> = {
  toFirestore(tsutsyk: TsutsykDoc): DocumentData {
    return tsutsyk;
  },
  fromFirestore(snapshot: QueryDocumentSnapshot<TsutsykDoc>): TsutsykDoc {
    const data = snapshot.data();
    return {
      createdAt: data.createdAt,
      photoUrl: data.photoUrl,
      alertDistanceMeters: data.alertDistanceMeters,
      // Docs created before the provisioning flow existed (seeded/legacy
      // trackers) were never meant to go through a claim step — treat them
      // as already claimed so they keep working and can't be claimed anew.
      claimed: data.claimed ?? true,
      claimedByUid: data.claimedByUid ?? null,
      claimedAt: data.claimedAt ?? null,
    };
  },
};

export const sessionConverter: FirestoreDataConverter<SessionDoc> = {
  toFirestore(session: SessionDoc): DocumentData {
    return session;
  },
  fromFirestore(snapshot: QueryDocumentSnapshot<SessionDoc>): SessionDoc {
    const data = snapshot.data();
    return {
      tsutsykId: data.tsutsykId,
      startTime: data.startTime,
      endTime: data.endTime,
      status: data.status,
      lastLocationAt: data.lastLocationAt,
    };
  },
};

export const locationConverter: FirestoreDataConverter<LocationDoc> = {
  toFirestore(location: LocationDoc): DocumentData {
    return location;
  },
  fromFirestore(snapshot: QueryDocumentSnapshot<LocationDoc>): LocationDoc {
    const data = snapshot.data();
    return {
      latitude: data.latitude,
      longitude: data.longitude,
      battery: data.battery,
      timestamp: data.timestamp,
    };
  },
};
