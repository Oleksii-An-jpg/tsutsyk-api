// Grants (or revokes) the `admin` custom claim that `AdminGuard` checks —
// the claim that lets someone record a dispatch against any order.
//
// Deliberately a script and not a mutation: nothing the API exposes can hand
// out admin, so a compromised storefront or a stolen customer token cannot
// escalate into one. Granting admin needs the service account, which means
// needing this repository and the project.
//
// Usage:
//   npm run grant:admin -- --email=someone@example.com
//   npm run grant:admin -- --uid=abc123
//   npm run grant:admin -- --email=someone@example.com --revoke
//
// The claim lands in the user's ID token the next time one is minted, so an
// already-signed-in browser keeps its old token until it refreshes (up to an
// hour, or immediately on `getIdToken(true)`). Revoking has the same lag —
// for a token that must stop working now, revoke the refresh tokens too.
import { getAuth } from 'firebase-admin/auth';
import { getFirebaseAdminApp } from '../src/firebase/firebase-admin.app';

function arg(name: string): string | undefined {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found?.split('=').slice(1).join('=').trim() || undefined;
}

async function main() {
  const email = arg('email');
  const uid = arg('uid');
  const revoke = process.argv.includes('--revoke');

  if (!email && !uid) {
    throw new Error('Pass --email=<address> or --uid=<uid>');
  }

  const auth = getAuth(getFirebaseAdminApp());
  const user = email
    ? await auth.getUserByEmail(email)
    : await auth.getUser(uid);

  // Custom claims are replaced wholesale, not merged, so the existing ones
  // are carried over by hand. Dropping somebody's unrelated claim while
  // making them an admin would be a quiet way to break something else.
  const claims = { ...(user.customClaims ?? {}) };
  if (revoke) {
    delete claims.admin;
  } else {
    claims.admin = true;
  }

  await auth.setCustomUserClaims(user.uid, claims);

  console.log(
    `${revoke ? 'Revoked admin from' : 'Granted admin to'} ${user.email ?? user.uid} (${user.uid}).`,
  );
  console.log(
    'Takes effect on their next ID token — sign out and back in, or call getIdToken(true).',
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
