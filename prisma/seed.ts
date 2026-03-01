import { PrismaClient } from '@prisma/client';

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

  // Trip 1: Morning commute along Krasnov St
  // Starting near the Hippodrome moving towards the center
  console.log('Seeding Session 1: Morning Commute...');
  const session1Id = 'session-morning-run';
  const startTime1 = new Date('2026-03-01T08:00:00Z');

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
      locations: {
        create: points1.map((p, index) => ({
          latitude: p.lat,
          longitude: p.lng,
          timestamp: new Date(startTime1.getTime() + index * 60000), // 1 min apart
          battery: 40,
        })),
      },
    },
  });

  // Trip 2: Evening return
  console.log('Seeding Session 2: Evening Return...');
  const session2Id = 'session-evening-return';
  const startTime2 = new Date('2026-03-01T18:00:00Z');

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
      locations: {
        create: points2.map((p, index) => ({
          latitude: p.lat,
          longitude: p.lng,
          timestamp: new Date(startTime2.getTime() + index * 60000),
        })),
      },
    },
  });

  console.log('✅ Seeding successful!');
  console.log(`Created Tsutsyk: ${tsutsykId}`);
  console.log(
    `Created 2 Sessions with ${points1.length + points2.length} total coordinates in Odesa.`,
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
