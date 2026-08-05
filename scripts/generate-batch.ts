// Provisions a batch of physical Tsutsyk trackers: generates unguessable
// ids, writes `claimed: false` docs to Firestore, and renders a printable
// sheet of QR codes (each encoding tsutsyk.live/tsutsyk/<id>) for the units.
//
// Usage:
//   npm run generate:batch -- --count=100
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomInt } from 'crypto';
import * as QRCode from 'qrcode';
import { Timestamp, getFirestore } from 'firebase-admin/firestore';
import { getFirebaseAdminApp } from '../src/firebase/firebase-admin.app';
import { tsutsykConverter } from '../src/firestore/converter';

// Visually ambiguous characters (0/O, 1/I/l) are excluded — these ids get
// printed/etched onto physical units and read back by support staff.
const ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
const ID_LENGTH = 10;

function generateId(): string {
  let id = '';
  for (let i = 0; i < ID_LENGTH; i++) {
    id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  }
  return id;
}

const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || 'tsutsyk-firestore';
const BASE_URL = process.env.TSUTSYK_BASE_URL || 'https://tsutsyk.live/tsutsyk';

// A single Firestore batch write tops out at 500 operations.
const MAX_BATCH_SIZE = 500;

function parseCount(): number {
  const arg = process.argv.find((a) => a.startsWith('--count='));
  const count = arg ? parseInt(arg.split('=')[1], 10) : 100;
  if (!Number.isInteger(count) || count <= 0 || count > MAX_BATCH_SIZE) {
    throw new Error(
      `--count must be an integer between 1 and ${MAX_BATCH_SIZE}`,
    );
  }
  return count;
}

async function main() {
  const count = parseCount();
  const db = getFirestore(getFirebaseAdminApp(), DATABASE_ID);
  const tsutsyks = db.collection('tsutsyks').withConverter(tsutsykConverter);

  const ids = new Set<string>();
  while (ids.size < count) ids.add(generateId());

  const now = Timestamp.now();
  const batch = db.batch();
  for (const id of ids) {
    batch.set(tsutsyks.doc(id), { createdAt: now, claimed: false });
  }
  await batch.commit();

  const outDir = join(
    process.cwd(),
    'batches',
    now.toDate().toISOString().replace(/[:.]/g, '-'),
  );
  mkdirSync(outDir, { recursive: true });

  const cards: string[] = [];
  for (const id of ids) {
    const url = `${BASE_URL}/${id}`;
    const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 300 });
    cards.push(
      `<div class="card"><img src="${qrDataUrl}" alt="${id}" /><code>${id}</code></div>`,
    );
  }

  writeFileSync(
    join(outDir, 'ids.csv'),
    'id,url\n' + [...ids].map((id) => `${id},${BASE_URL}/${id}`).join('\n'),
  );

  writeFileSync(
    join(outDir, 'sheet.html'),
    `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Tsutsyk batch — ${ids.size} units</title>
<style>
  body { font-family: sans-serif; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
  .card { border: 1px solid #ccc; border-radius: 8px; padding: 8px; text-align: center; break-inside: avoid; }
  .card img { width: 100%; height: auto; }
  .card code { font-size: 12px; }
  @media print { .card { border-color: #000; } }
</style>
</head>
<body>
  <h1>Tsutsyk batch — ${ids.size} units — ${now.toDate().toISOString()}</h1>
  <div class="grid">${cards.join('')}</div>
</body>
</html>`,
  );

  console.log(`Wrote ${ids.size} unclaimed Tsutsyk docs to Firestore.`);
  console.log(`Print sheet: ${join(outDir, 'sheet.html')}`);
  console.log(`Id/URL list: ${join(outDir, 'ids.csv')}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
