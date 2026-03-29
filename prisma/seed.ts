import { PrismaClient, SessionStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Cleaning up database...');
  await prisma.location.deleteMany({});
  await prisma.session.deleteMany({});
  await prisma.tsutsyk.deleteMany({});

  console.log('Creating Tsutsyk...');
  const tsutsykId = 'tsutsyk-odesa-01';

  const tsutsyk = await prisma.tsutsyk.create({
    data: {
      id: tsutsykId,
    },
  });

  // Trip 1: Morning commute - COMPLETED
  console.log('Seeding Session 1: Morning Commute (Completed)...');
  const session1Id = 'session-2026-03-01-morning';
  const startTime1 = new Date('2026-03-01T08:00:00Z');
  const endTime1 = new Date('2026-03-01T08:30:00Z');

  const points1 = [
    { lat: 46.4445, lng: 30.7312 }, // Near Hippodrome
    { lat: 46.4462, lng: 30.7295 }, // Moving North on Krasnov
    { lat: 46.4485, lng: 30.727 }, // Near General Shvydchenko St
    { lat: 46.451, lng: 30.7245 }, // Approaching Admiralsky Ave
  ];

  await prisma.session.create({
    data: {
      id: session1Id,
      tsutsykId: tsutsyk.id,
      startTime: startTime1,
      endTime: endTime1,
      status: SessionStatus.COMPLETED,
      locations: {
        create: points1.map((p, index) => ({
          latitude: p.lat,
          longitude: p.lng,
          timestamp: new Date(startTime1.getTime() + index * 60000), // 1 min apart
          battery: 95 - index * 2, // Battery drains over time
        })),
      },
    },
  });

  // Trip 2: Evening return - COMPLETED
  console.log('Seeding Session 2: Evening Return (Completed)...');
  const session2Id = 'session-2026-03-01-evening';
  const startTime2 = new Date('2026-03-01T18:00:00Z');
  const endTime2 = new Date('2026-03-01T18:25:00Z');

  const points2 = [
    { lat: 46.4512, lng: 30.7243 },
    { lat: 46.449, lng: 30.7265 },
    { lat: 46.447, lng: 30.7288 },
    { lat: 46.445, lng: 30.7305 },
  ];

  await prisma.session.create({
    data: {
      id: session2Id,
      tsutsykId: tsutsyk.id,
      startTime: startTime2,
      endTime: endTime2,
      status: SessionStatus.COMPLETED,
      locations: {
        create: points2.map((p, index) => ({
          latitude: p.lat,
          longitude: p.lng,
          timestamp: new Date(startTime2.getTime() + index * 60000),
          battery: 85 - index * 3,
        })),
      },
    },
  });

  // Trip 3: Current Active Session - ACTIVE
  console.log('Seeding Session 3: Active Walk (In Progress)...');
  const session3Id = 'session-2026-03-15-active';
  const startTime3 = new Date(Date.now() - 30 * 60000); // Started 30 minutes ago

  const points3 = [
    { lat: 46.4825, lng: 30.7233 }, // Starting point (Potemkin Stairs area)
    { lat: 46.4835, lng: 30.725 }, // Moving along Primorsky Boulevard
    { lat: 46.4845, lng: 30.7265 }, // Towards City Garden
    { lat: 46.4855, lng: 30.728 }, // Near Deribasivska Street
    { lat: 46.4862, lng: 30.729 }, // Current position
  ];

  await prisma.session.create({
    data: {
      id: session3Id,
      tsutsykId: tsutsyk.id,
      startTime: startTime3,
      endTime: null, // Still active!
      status: SessionStatus.ACTIVE,
      locations: {
        create: points3.map((p, index) => ({
          latitude: p.lat,
          longitude: p.lng,
          timestamp: new Date(startTime3.getTime() + index * 5 * 60000), // 5 min apart
          battery: 100 - index * 5, // Battery draining
        })),
      },
    },
  });

  console.log('✅ Seeding successful!');
  console.log(`Created Tsutsyk: ${tsutsykId}`);
  console.log(`Created 3 Sessions:`);
  console.log(`  - 2 completed sessions (morning & evening)`);
  console.log(`  - 1 active session (current walk)`);
  console.log(
    `Total locations: ${points1.length + points2.length + points3.length}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
