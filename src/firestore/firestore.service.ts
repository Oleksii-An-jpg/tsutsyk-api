import { Injectable } from '@nestjs/common';
import { getFirestore, Firestore } from 'firebase-admin/firestore';
import { getFirebaseApp } from '../firebase/firebase-admin';
import {
  tsutsykConverter,
  sessionConverter,
  locationConverter,
} from './converter';

const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || 'tsutsyk-firestore';

@Injectable()
export class FirestoreService {
  readonly db: Firestore;

  constructor() {
    this.db = getFirestore(getFirebaseApp(), DATABASE_ID);
  }

  get tsutsyks() {
    return this.db.collection('tsutsyks').withConverter(tsutsykConverter);
  }

  get sessions() {
    return this.db.collection('sessions').withConverter(sessionConverter);
  }

  sessionLocations(sessionId: string) {
    return this.sessions
      .doc(sessionId)
      .collection('locations')
      .withConverter(locationConverter);
  }
}
