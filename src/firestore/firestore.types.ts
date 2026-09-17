import { Timestamp } from 'firebase-admin/firestore';
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
