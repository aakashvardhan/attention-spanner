/**
 * Firebase web config for project `adhd-reader-ios-firebase-sync`.
 *
 * Paste the values from the Firebase console:
 *   Project settings → General → Your apps → (register/select a Web app) →
 *   "SDK setup and configuration" → Config. Copy the `firebaseConfig` fields.
 *
 * The web `apiKey` is NOT a secret — it identifies the project and is meant to
 * ship in client code; access is governed by Firestore security rules + auth.
 * Once these are filled in, sync activates automatically (see
 * src/background/firestoreBackend.ts). Leaving `apiKey` blank keeps sync off.
 */
export const firebaseConfig = {
  apiKey: 'AIzaSyDP_COF6eMak9YfsQFfafTYI5nEdg9HNh8',
  authDomain: 'adhd-reader-ios-firebase-sync.firebaseapp.com',
  projectId: 'adhd-reader-ios-firebase-sync',
  storageBucket: 'adhd-reader-ios-firebase-sync.firebasestorage.app',
  messagingSenderId: '757033616335',
  appId: '1:757033616335:web:6b76a33d9510ef703288ba',
};

export const isFirebaseConfigured = firebaseConfig.apiKey.trim() !== '';
