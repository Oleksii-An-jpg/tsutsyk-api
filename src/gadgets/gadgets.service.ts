import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { FirestoreService } from '../firestore/firestore.service';
import { getFirebaseApp } from '../firebase/firebase-admin';

const DEFAULT_CLIENT_APP_URL = 'https://tsutsyk.live';

export interface GadgetStatus {
  id: string;
  claimed: boolean;
}

@Injectable()
export class GadgetsService {
  constructor(private readonly firestore: FirestoreService) {}

  // Called once per physical unit, at flashing time — generates the ID that
  // gets written into the device's NVS and printed as a QR code on the
  // enclosure. The record starts unclaimed until someone scans it and signs in.
  async provision(): Promise<{ gadgetId: string; claimUrl: string }> {
    const gadgetId = randomUUID();

    await this.firestore.tsutsyks.doc(gadgetId).set({
      createdAt: Timestamp.now(),
      photoUrl: null,
      alertDistanceMeters: null,
      claimed: false,
      claimedByUid: null,
      claimedAt: null,
    });

    const baseUrl = (
      process.env.CLIENT_APP_URL ?? DEFAULT_CLIENT_APP_URL
    ).replace(/\/$/, '');

    return { gadgetId, claimUrl: `${baseUrl}/claim/${gadgetId}` };
  }

  async getGadgetStatus(gadgetId: string): Promise<GadgetStatus | null> {
    const doc = await this.firestore.tsutsyks.doc(gadgetId).get();
    if (!doc.exists) return null;

    return { id: doc.id, claimed: doc.data().claimed };
  }

  // Idempotent for the same uid so a retried request (flaky network, double
  // tap) doesn't fail; a different uid trying to claim an already-claimed
  // gadget is rejected.
  async claimGadget(gadgetId: string, uid: string): Promise<void> {
    const ref = this.firestore.tsutsyks.doc(gadgetId);

    await this.firestore.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        throw new NotFoundException('Unknown gadget id');
      }

      const data = snap.data();
      if (data.claimed) {
        if (data.claimedByUid === uid) return;
        throw new ConflictException('Gadget is already claimed');
      }

      tx.update(ref, {
        claimed: true,
        claimedByUid: uid,
        claimedAt: Timestamp.now(),
      });
    });

    await this.grantTsutsykClaim(uid, gadgetId);
  }

  private async grantTsutsykClaim(uid: string, gadgetId: string) {
    const auth = getAuth(getFirebaseApp());
    const user = await auth.getUser(uid);
    const existingClaims = user.customClaims ?? {};
    const existingIds: string[] = Array.isArray(existingClaims.tsutsykIds)
      ? (existingClaims.tsutsykIds as string[])
      : [];

    if (existingIds.includes(gadgetId)) return;

    await auth.setCustomUserClaims(uid, {
      ...existingClaims,
      tsutsykIds: [...existingIds, gadgetId],
    });
  }
}
