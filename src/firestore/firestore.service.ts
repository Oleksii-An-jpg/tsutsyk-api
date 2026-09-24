import { Injectable } from '@nestjs/common';
import { getFirestore, Firestore } from 'firebase-admin/firestore';
import { getFirebaseAdminApp } from '../firebase/firebase-admin.app';
import {
  tsutsykConverter,
  sessionConverter,
  locationConverter,
  orderConverter,
  pushSubscriptionConverter,
  alertAreaConverter,
} from './converter';

const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || 'tsutsyk-firestore';

@Injectable()
export class FirestoreService {
  readonly db: Firestore;

  constructor() {
    this.db = getFirestore(getFirebaseAdminApp(), DATABASE_ID);
  }

  get tsutsyks() {
    return this.db.collection('tsutsyks').withConverter(tsutsykConverter);
  }

  get sessions() {
    return this.db.collection('sessions').withConverter(sessionConverter);
  }

  get orders() {
    return this.db.collection('orders').withConverter(orderConverter);
  }

  get pushSubscriptions() {
    return this.db
      .collection('pushSubscriptions')
      .withConverter(pushSubscriptionConverter);
  }

  alertAreas(tsutsykId: string) {
    return this.tsutsyks
      .doc(tsutsykId)
      .collection('alertAreas')
      .withConverter(alertAreaConverter);
  }

  sessionLocations(sessionId: string) {
    return this.sessions
      .doc(sessionId)
      .collection('locations')
      .withConverter(locationConverter);
  }
}
