import { Timestamp } from 'firebase-admin/firestore';
import { GeofenceState } from '../geofence/geofence';
import {
  DeliveryMethod,
  OrderActor,
  OrderStatus,
  PaymentStatus,
  SessionStatus,
} from '../graphql.schema';

export interface TsutsykDoc {
  createdAt: Timestamp;
  claimed: boolean;
  ownerUid?: string | null;
  name?: string | null;
  photoUrl?: string | null;
  alertDistanceMeters?: number | null;
  /**
   * alerts.in.ua oblast uid whose air raid alerts this tracker follows.
   * Null/absent means the owner has not chosen one, and the tracker stays on
   * its everyday reporting cadence.
   */
  alertRegionUid?: number | null;
  claimedAt?: Timestamp | null;
  /**
   * Whether the owner has already been told this tracker's battery is low.
   *
   * Lives on the document because the warning has to be edge-triggered and a
   * tracker reports every five minutes: without somewhere to remember that we
   * have said it, a flat battery would be a notification twelve times an hour.
   */
  lowBatteryNotified?: boolean | null;
  /**
   * Where the last fix put the tracker relative to its alert areas.
   *
   * Remembered for the same reason as `lowBatteryNotified`: the exit alert is
   * edge-triggered, and the edge is between this fix and the one before it.
   * Reset to null whenever the areas change, so a redrawn fence starts from
   * "we do not know" instead of from a comparison with a shape that is gone.
   */
  geofence?: GeofenceState;
}

/**
 * A polygon on the map a tracker is expected to stay inside.
 *
 * Lives under its tracker (`tsutsyks/{id}/alertAreas`) rather than in a
 * collection of its own: every question we ask of it starts from a tracker,
 * and ownership is the tracker's owner, so there is no second field to keep
 * in step with the first.
 */
export interface AlertAreaDoc {
  name: string;
  /** The outline, in order. Closed implicitly: the last point joins the first. */
  points: { lat: number; lng: number }[];
  /** Paused areas are kept but ignored by the exit check. */
  enabled: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface SessionDoc {
  tsutsykId: string;
  startTime: Timestamp;
  endTime: Timestamp | null;
  status: SessionStatus;
  lastLocationAt: Timestamp | null;
}

export interface LocationDoc {
  latitude: number;
  longitude: number;
  battery: number | null;
  timestamp: Timestamp;
}

export interface OrderItemDoc {
  productId: string;
  name: string;
  /** Minor units (kopiykas), frozen at the moment the order was placed. */
  unitPrice: number;
  quantity: number;
  sum: number;
  unit: string;
  image: string | null;
}

export interface OrderDeliveryDoc {
  method: DeliveryMethod;
  recipientName: string;
  phone: string;
  city: string | null;
  branch: string | null;
  address: string | null;
  comment: string | null;
}

export interface OrderEventDoc {
  at: Timestamp;
  status: OrderStatus;
  actor: OrderActor;
  note: string | null;
  /**
   * Which admin did this, for the entries we caused by hand.
   *
   * Stored but never exposed: `Order.events` is read by the customer, and who
   * on our side pressed the button is our business, not theirs. Absent on
   * everything a customer or monobank caused — the actor already says so.
   */
  byUid?: string | null;
}

export interface OrderDoc {
  /** Null until the order is claimed — a pre-order can be paid as a guest. */
  ownerUid: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  items: OrderItemDoc[];
  /** Total in minor units (kopiykas). */
  amount: number;
  currency: number;
  status: OrderStatus;
  /** Null until the first webhook or status poll lands. */
  paymentStatus: PaymentStatus | null;
  invoiceId: string | null;
  paymentPageUrl: string | null;
  /** monobank's own timestamp, and the tiebreaker between two webhooks. */
  paymentModifiedDate: string | null;
  failureReason: string | null;
  cancelReason: string | null;
  delivery: OrderDeliveryDoc | null;
  trackingNumber: string | null;
  /** The units shipped against this order, once they are assigned. */
  tsutsykIds: string[];
  events: OrderEventDoc[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
  paidAt: Timestamp | null;
}

/**
 * One browser's Web Push subscription.
 *
 * Keyed by a hash of the endpoint rather than by uid: a person has as many of
 * these as they have browsers, and re-subscribing the same one has to land on
 * the same document or every reinstall would leave a dead endpoint behind for
 * us to keep pushing at.
 */
export interface PushSubscriptionDoc {
  /** Who this browser belongs to. The only key we fan out by. */
  ownerUid: string;
  /** The push service URL. Opaque to us, and the identity of the device. */
  endpoint: string;
  /** The keys web-push encrypts the payload with. */
  keys: { p256dh: string; auth: string };
  createdAt: Timestamp;
  /** Last time a send to this endpoint was accepted. */
  lastSeenAt: Timestamp;
  /**
   * What the browser called itself when it subscribed, so an owner listing
   * their devices sees something other than a base64 blob. Never matched on.
   */
  userAgent: string | null;
}
