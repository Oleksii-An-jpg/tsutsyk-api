import { getApps, initializeApp, App } from 'firebase-admin/app';

const PROJECT_ID =
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCLOUD_PROJECT ||
  'tsutsyk-live';

let app: App | undefined;

// On Cloud Run/App Engine, initializeApp() auto-detects both credentials
// and projectId from the metadata server. Locally/against the emulator
// there's no metadata server, so projectId needs to be given explicitly.
export function getFirebaseAdminApp(): App {
  if (!app) {
    app = getApps()[0] ?? initializeApp({ projectId: PROJECT_ID });
  }
  return app;
}
