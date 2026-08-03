import { Timestamp } from 'firebase-admin/firestore';
import { SessionStatus } from '../graphql.schema';

export interface TsutsykDoc {
  createdAt: Timestamp;
  photoUrl?: string | null;
  alertDistanceMeters?: number | null;
  claimed: boolean;
  claimedByUid: string | null;
  claimedAt: Timestamp | null;
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
