/**
 * Firebase web config for project `adhd-reader-ios-firebase-sync`.
 *
 * Values are read from Vite env vars at build time (see `.env.example`).
 * Copy `.env.example` to `.env.local` and paste the values from the Firebase
 * console: Project settings → General → Your apps → (register/select a Web
 * app) → "SDK setup and configuration" → Config.
 *
 * `.env.local` is gitignored so config isn't hardcoded into source. Note the
 * web `apiKey` is NOT a secret — it identifies the project and is meant to
 * ship in client code (it is embedded in the built bundle regardless); access
 * is governed by Firestore security rules + auth, so keeping it out of source
 * is about hygiene, not confidentiality.
 *
 * Once these are filled in, sync activates automatically (see
 * src/background/firestoreBackend.ts). Leaving `apiKey` blank keeps sync off.
 */
export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? '',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? '',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? '',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? '',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '',
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? '',
};

export const isFirebaseConfigured = firebaseConfig.apiKey.trim() !== '';
