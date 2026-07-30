import { Injectable } from '@nestjs/common';
import { getApps, initializeApp, App } from 'firebase-admin/app';
import { getFirestore, Firestore } from 'firebase-admin/firestore';
import {
  tsutsykConverter,
  sessionConverter,
  locationConverter,
} from './firestore-converter';

const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || 'tsutsyk-firestore';
const PROJECT_ID =
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCLOUD_PROJECT ||
  'tsutsyk-live';

@Injectable()
export class FirestoreService {
  readonly db: Firestore;

  constructor() {
    // On Cloud Run/App Engine, initializeApp() auto-detects both credentials
    // and projectId from the metadata server. Locally/against the emulator
    // there's no metadata server, so projectId needs to be given explicitly.
    const app: App = getApps()[0] ?? initializeApp({ projectId: PROJECT_ID });
    this.db = getFirestore(app, DATABASE_ID);
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
