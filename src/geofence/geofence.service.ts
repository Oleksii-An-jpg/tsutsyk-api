import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DocumentSnapshot, Timestamp } from 'firebase-admin/firestore';
import { FirestoreService } from '../firestore/firestore.service';
import { AlertAreaDoc, TsutsykDoc } from '../firestore/firestore.types';
import { AlertArea as GqlAlertArea } from '../graphql.schema';
import { NotificationsService } from '../notifications/notifications.service';
import {
  LatLng,
  MAX_AREA_NAME_LENGTH,
  MAX_AREA_POINTS,
  MAX_AREAS_PER_TRACKER,
  MIN_AREA_POINTS,
  MIN_AREA_SQUARE_METERS,
  polygonAreaSquareMeters,
  stepGeofence,
} from './geofence';

/**
 * Alert areas: storing the fences an owner draws, and noticing when a tracker
 * leaves them.
 *
 * The check lives here, on the API, because the API is the one process that
 * sees every fix. The storefront only sees them while somebody has the map
 * open, and a dog slipping out of the yard at night is exactly the moment
 * nobody does.
 */
@Injectable()
export class GeofenceService {
  private readonly logger = new Logger(GeofenceService.name);

  constructor(
    private readonly firestore: FirestoreService,
    private readonly notifications: NotificationsService,
  ) {}

  async listAreas(uid: string, tsutsykId: string): Promise<GqlAlertArea[]> {
    await this.assertOwner(uid, tsutsykId);
    const snapshot = await this.firestore
      .alertAreas(tsutsykId)
      .orderBy('createdAt', 'asc')
      .get();
    return snapshot.docs.map((doc) => toGql(tsutsykId, doc.id, doc.data()));
  }

  async createArea({
    uid,
    tsutsykId,
    name,
    points,
  }: {
    uid: string;
    tsutsykId: string;
    name: string;
    points: LatLng[];
  }): Promise<GqlAlertArea> {
    await this.assertOwner(uid, tsutsykId);

    const areas = this.firestore.alertAreas(tsutsykId);
    const count = (await areas.count().get()).data().count;
    if (count >= MAX_AREAS_PER_TRACKER) {
      throw new BadRequestException(
        `A tracker can have at most ${MAX_AREAS_PER_TRACKER} areas`,
      );
    }

    const now = Timestamp.now();
    const doc: AlertAreaDoc = {
      name: validName(name),
      points: validPoints(points),
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    const ref = areas.doc();

    const batch = this.firestore.db.batch();
    batch.set(ref, doc);
    this.forgetState(batch, tsutsykId);
    await batch.commit();

    return toGql(tsutsykId, ref.id, doc);
  }

  async updateArea({
    uid,
    tsutsykId,
    id,
    name,
    points,
    enabled,
  }: {
    uid: string;
    tsutsykId: string;
    id: string;
    name?: string | null;
    points?: LatLng[] | null;
    enabled?: boolean | null;
  }): Promise<GqlAlertArea> {
    await this.assertOwner(uid, tsutsykId);

    const ref = this.firestore.alertAreas(tsutsykId).doc(id);
    const existing = await ref.get();
    if (!existing.exists) throw new NotFoundException('No such area');

    const update: Partial<AlertAreaDoc> = { updatedAt: Timestamp.now() };
    if (name != null) update.name = validName(name);
    if (points != null) update.points = validPoints(points);
    if (enabled != null) update.enabled = enabled;

    const batch = this.firestore.db.batch();
    batch.set(ref, update, { merge: true });
    this.forgetState(batch, tsutsykId);
    await batch.commit();

    return toGql(tsutsykId, id, { ...existing.data(), ...update });
  }

  async deleteArea({
    uid,
    tsutsykId,
    id,
  }: {
    uid: string;
    tsutsykId: string;
    id: string;
  }): Promise<boolean> {
    await this.assertOwner(uid, tsutsykId);

    const batch = this.firestore.db.batch();
    batch.delete(this.firestore.alertAreas(tsutsykId).doc(id));
    this.forgetState(batch, tsutsykId);
    await batch.commit();
    return true;
  }

  /**
   * Weighs one fix against the tracker's areas, and tells the owner if it is
   * the one that took the tracker out.
   *
   * Never throws and never rejects: like the battery warning, it runs detached
   * from the device request that brought the fix in.
   */
  async checkFix(tsutsykId: string, point: LatLng): Promise<void> {
    try {
      const areasQuery = this.firestore
        .alertAreas(tsutsykId)
        .where('enabled', '==', true);

      // Most trackers have no areas. Find that out with one read, before
      // paying for a transaction on the tracker document every fix. Nothing
      // is left to clean up when there are none: removing or pausing the last
      // area already reset the state.
      if ((await areasQuery.limit(1).get()).empty) return;

      const tsutsykRef = this.firestore.tsutsyks.doc(tsutsykId);
      // The areas are read inside the transaction as well as the tracker:
      // every edit to an area also resets `geofence`, so an edit landing
      // mid-check sends this back round with the new shapes rather than
      // letting it write a verdict about the old ones.
      const outcome = await this.firestore.db.runTransaction(async (tx) => {
        const [tsutsykSnap, areasSnap] = await Promise.all([
          tx.get(tsutsykRef),
          tx.get(areasQuery),
        ]);
        if (!tsutsykSnap.exists) return null;

        const data = tsutsykSnap.data();
        const areas = areasSnap.docs.map((doc) => ({
          id: doc.id,
          name: doc.data().name,
          points: doc.data().points,
        }));
        const step = stepGeofence({
          state: data.geofence ?? null,
          areas,
          point,
        });

        if (!sameState(data.geofence ?? null, step.state)) {
          tx.set(tsutsykRef, { geofence: step.state }, { merge: true });
        }
        return { data, left: step.left };
      });

      if (!outcome?.left || !outcome.data.ownerUid) return;
      await this.notifyExit(tsutsykId, outcome.data, outcome.left.name);
    } catch (error) {
      this.logger.warn(
        `alert area check for ${tsutsykId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async notifyExit(
    tsutsykId: string,
    data: TsutsykDoc,
    areaName: string,
  ): Promise<void> {
    const name = data.name || 'Цуцик';
    await this.notifications.sendToUser(data.ownerUid, {
      title: `${name} поза зоною`,
      body: `${name} вийшов за межі «${areaName}».`,
      url: '/me',
      // One banner per dog: a second exit replaces the first rather than
      // stacking, since only where it is now matters.
      tag: `alert-area-${tsutsykId}`,
    });
  }

  /**
   * Resets what we know about where the tracker is.
   *
   * Every change to the areas goes through here. Without it, drawing a new
   * fence around a tracker that was "outside" the old one would compare the
   * next fix against a shape that no longer exists.
   */
  private forgetState(
    batch: FirebaseFirestore.WriteBatch,
    tsutsykId: string,
  ): void {
    batch.set(
      this.firestore.tsutsyks.doc(tsutsykId),
      { geofence: null },
      { merge: true },
    );
  }

  private async assertOwner(uid: string, tsutsykId: string): Promise<void> {
    const snap: DocumentSnapshot<TsutsykDoc> = await this.firestore.tsutsyks
      .doc(tsutsykId)
      .get();
    if (!snap.exists || snap.data()?.ownerUid !== uid) {
      throw new ForbiddenException('You do not own this Tsutsyk');
    }
  }
}

function toGql(tsutsykId: string, id: string, doc: AlertAreaDoc): GqlAlertArea {
  return {
    id,
    tsutsykId,
    name: doc.name,
    points: doc.points.map(({ lat, lng }) => ({ lat, lng })),
    enabled: doc.enabled,
  };
}

function sameState(
  a: TsutsykDoc['geofence'],
  b: TsutsykDoc['geofence'],
): boolean {
  if (a == null || b == null) return a == b;
  return a.inside === b.inside && a.areaId === b.areaId;
}

function validName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_AREA_NAME_LENGTH) {
    throw new BadRequestException(
      `The name must be 1 to ${MAX_AREA_NAME_LENGTH} characters`,
    );
  }
  return trimmed;
}

/**
 * Checks an outline before it is stored.
 *
 * The client draws these by hand, a tap at a time, and a shape the exit check
 * cannot use — too few points, off the map, or folded flat — is one that
 * would report the tracker as outside on every fix, forever.
 */
function validPoints(points: LatLng[]): { lat: number; lng: number }[] {
  if (points.length < MIN_AREA_POINTS || points.length > MAX_AREA_POINTS) {
    throw new BadRequestException(
      `An area needs ${MIN_AREA_POINTS} to ${MAX_AREA_POINTS} points`,
    );
  }
  for (const { lat, lng } of points) {
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      throw new BadRequestException('Every point must be a real coordinate');
    }
  }
  if (polygonAreaSquareMeters(points) < MIN_AREA_SQUARE_METERS) {
    throw new BadRequestException('The area is too small to be a fence');
  }
  // Copied field by field so nothing else a client sends ends up stored.
  return points.map(({ lat, lng }) => ({ lat, lng }));
}
