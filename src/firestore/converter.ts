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
      // Docs created before the claiming feature existed have no `claimed`
      // field — treat them as already claimed rather than bouncing an
      // in-use tracker back into the onboarding flow.
      claimed: data.claimed ?? true,
      ownerUid: data.ownerUid,
      name: data.name,
      photoUrl: data.photoUrl,
      alertDistanceMeters: data.alertDistanceMeters,
      claimedAt: data.claimedAt,
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
