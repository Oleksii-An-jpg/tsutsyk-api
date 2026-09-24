import {
  DocumentData,
  FirestoreDataConverter,
  QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import {
  AlertAreaDoc,
  LocationDoc,
  OrderDoc,
  PushSubscriptionDoc,
  SessionDoc,
  TsutsykDoc,
} from './firestore.types';

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
      alertRegionUid: data.alertRegionUid,
      claimedAt: data.claimedAt,
      lowBatteryNotified: data.lowBatteryNotified ?? false,
      geofence: data.geofence ?? null,
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

export const orderConverter: FirestoreDataConverter<OrderDoc> = {
  toFirestore(order: OrderDoc): DocumentData {
    return order;
  },
  fromFirestore(snapshot: QueryDocumentSnapshot<OrderDoc>): OrderDoc {
    const data = snapshot.data();
    return {
      ownerUid: data.ownerUid ?? null,
      contactPhone: data.contactPhone ?? null,
      contactEmail: data.contactEmail ?? null,
      // Lists are read back defensively: a half-written order is still worth
      // showing its owner, and an absent array would blow up the resolver.
      items: data.items ?? [],
      amount: data.amount,
      currency: data.currency,
      status: data.status,
      paymentStatus: data.paymentStatus ?? null,
      invoiceId: data.invoiceId ?? null,
      paymentPageUrl: data.paymentPageUrl ?? null,
      paymentModifiedDate: data.paymentModifiedDate ?? null,
      failureReason: data.failureReason ?? null,
      cancelReason: data.cancelReason ?? null,
      delivery: data.delivery ?? null,
      trackingNumber: data.trackingNumber ?? null,
      tsutsykIds: data.tsutsykIds ?? [],
      events: data.events ?? [],
      createdAt: data.createdAt,
      updatedAt: data.updatedAt ?? data.createdAt,
      paidAt: data.paidAt ?? null,
    };
  },
};

export const pushSubscriptionConverter: FirestoreDataConverter<PushSubscriptionDoc> =
  {
    toFirestore(subscription: PushSubscriptionDoc): DocumentData {
      return subscription;
    },
    fromFirestore(
      snapshot: QueryDocumentSnapshot<PushSubscriptionDoc>,
    ): PushSubscriptionDoc {
      const data = snapshot.data();
      return {
        ownerUid: data.ownerUid,
        endpoint: data.endpoint,
        keys: data.keys,
        createdAt: data.createdAt,
        // Docs written before this field existed fall back to their creation
        // time rather than to null: "never seen" and "seen when it was made"
        // are the same thing for a subscription nothing has pushed to yet.
        lastSeenAt: data.lastSeenAt ?? data.createdAt,
        userAgent: data.userAgent ?? null,
      };
    },
  };

export const alertAreaConverter: FirestoreDataConverter<AlertAreaDoc> = {
  toFirestore(area: AlertAreaDoc): DocumentData {
    return area;
  },
  fromFirestore(snapshot: QueryDocumentSnapshot<AlertAreaDoc>): AlertAreaDoc {
    const data = snapshot.data();
    return {
      name: data.name,
      points: data.points ?? [],
      enabled: data.enabled ?? true,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt ?? data.createdAt,
    };
  },
};
