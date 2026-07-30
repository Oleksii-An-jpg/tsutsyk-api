import { Timestamp } from 'firebase-admin/firestore';
import { FirestoreService } from '../src/firestore/firestore.service';
import { SessionStatus } from '../src/graphql.schema';

const firestore = new FirestoreService();
const db = firestore.db;

async function seedSession(
  tsutsykId: string,
  sessionId: string,
  startTime: Date,
  endTime: Date | null,
  status: SessionStatus,
  points: { lat: number; lng: number }[],
  spacingMinutes: number,
  startBattery: number,
  batteryDrainPerPoint: number,
) {
  const lastPointTime = points.length
    ? new Date(
        startTime.getTime() + (points.length - 1) * spacingMinutes * 60000,
      )
    : null;

  await firestore.sessions.doc(sessionId).set({
    tsutsykId,
    startTime: Timestamp.fromDate(startTime),
    endTime: endTime ? Timestamp.fromDate(endTime) : null,
    status,
    lastLocationAt: lastPointTime ? Timestamp.fromDate(lastPointTime) : null,
  });

  const batch = db.batch();
  points.forEach((p, index) => {
    const ref = firestore.sessionLocations(sessionId).doc();
    batch.set(ref, {
      latitude: p.lat,
      longitude: p.lng,
      battery: startBattery - index * batteryDrainPerPoint,
      timestamp: Timestamp.fromDate(
        new Date(startTime.getTime() + index * spacingMinutes * 60000),
      ),
    });
  });
  await batch.commit();
}

async function main() {
  console.log('Cleaning up Firestore...');
  await db.recursiveDelete(firestore.sessions);
  await db.recursiveDelete(firestore.tsutsyks);

  console.log('Creating Tsutsyk...');
  const tsutsykId = 'tsutsyk-odesa-01';
  await firestore.tsutsyks.doc(tsutsykId).set({ createdAt: Timestamp.now() });

  console.log('Seeding Session 1: Morning Commute (Completed)...');
  await seedSession(
    tsutsykId,
    'session-2026-03-01-morning',
    new Date('2026-03-01T08:00:00Z'),
    new Date('2026-03-01T08:30:00Z'),
    SessionStatus.COMPLETED,
    [
      { lat: 46.4445, lng: 30.7312 }, // Near Hippodrome
      { lat: 46.4462, lng: 30.7295 }, // Moving North on Krasnov
      { lat: 46.4485, lng: 30.727 }, // Near General Shvydchenko St
      { lat: 46.451, lng: 30.7245 }, // Approaching Admiralsky Ave
    ],
    1, // 1 min apart
    95,
    2, // battery drains over time
  );

  console.log('Seeding Session 2: Evening Return (Completed)...');
  await seedSession(
    tsutsykId,
    'session-2026-03-01-evening',
    new Date('2026-03-01T18:00:00Z'),
    new Date('2026-03-01T18:25:00Z'),
    SessionStatus.COMPLETED,
    [
      { lat: 46.4512, lng: 30.7243 },
      { lat: 46.449, lng: 30.7265 },
      { lat: 46.447, lng: 30.7288 },
      { lat: 46.445, lng: 30.7305 },
    ],
    1,
    85,
    3,
  );

  console.log('Seeding Session 3: Active Walk (In Progress)...');
  const startTime3 = new Date(Date.now() - 30 * 60000); // Started 30 minutes ago
  await seedSession(
    tsutsykId,
    'session-2026-03-15-active',
    startTime3,
    null, // Still active!
    SessionStatus.ACTIVE,
    [
      { lat: 46.4825, lng: 30.7233 }, // Starting point (Potemkin Stairs area)
      { lat: 46.4835, lng: 30.725 }, // Moving along Primorsky Boulevard
      { lat: 46.4845, lng: 30.7265 }, // Towards City Garden
      { lat: 46.4855, lng: 30.728 }, // Near Deribasivska Street
      { lat: 46.4862, lng: 30.729 }, // Current position
    ],
    5, // 5 min apart
    100,
    5, // battery draining
  );

  console.log('✅ Seeding successful!');
  console.log(`Created Tsutsyk: ${tsutsykId}`);
  console.log('Created 3 Sessions: 2 completed sessions, 1 active session');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => process.exit(0));
