import { getApps, initializeApp } from 'firebase/app';
import {
  createUserWithEmailAndPassword,
  indexedDBLocalPersistence,
  initializeAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  type Auth,
} from 'firebase/auth';
import {
  collection,
  doc,
  initializeFirestore,
  onSnapshot,
  setDoc,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import { firebaseConfig, isFirebaseConfigured } from '../shared/firebaseConfig';
import type { SyncRecord } from '../shared/sync/collections';
import { registerSyncBackend, startSync, stopSync, type SyncBackend } from './sync';

/**
 * Firestore implementation of the sync transport, plus email/password auth.
 * This is the one credential-dependent module; everything else is transport-
 * agnostic. Activates itself on import (side effect at bottom) so it survives
 * MV3 service-worker wake-ups, which do not re-fire onInstalled/onStartup.
 *
 * Firestore runs over long polling (`experimentalAutoDetectLongPolling`) —
 * WebChannel streaming is unreliable inside an MV3 service worker. Auth uses
 * IndexedDB persistence so the session survives worker restarts.
 */

let auth: Auth | null = null;
let db: Firestore | null = null;
let currentUid: string | null = null;

function ensureAuth(): Auth {
  if (!auth) throw new Error('Sync is not configured — add your Firebase web config.');
  return auth;
}

const backend: SyncBackend = {
  async pushRecords(collectionName, records) {
    if (!db || !currentUid) return;
    const batch = writeBatch(db);
    for (const r of records) {
      batch.set(
        doc(db, 'users', currentUid, collectionName, r.id),
        r as unknown as Record<string, unknown>,
      );
    }
    await batch.commit();
  },
  async deleteRecords(collectionName, ids) {
    if (!db || !currentUid || ids.length === 0) return;
    const batch = writeBatch(db);
    for (const id of ids) batch.delete(doc(db, 'users', currentUid, collectionName, id));
    await batch.commit();
  },
  async pushDoc(path, data) {
    if (!db || !currentUid) return;
    const [col, id] = path.split('/');
    await setDoc(doc(db, 'users', currentUid, col, id), data as Record<string, unknown>);
  },
  subscribeRecords(collectionName, cb) {
    if (!db || !currentUid) return () => {};
    return onSnapshot(collection(db, 'users', currentUid, collectionName), (snap) => {
      cb(snap.docs.map((d) => d.data() as SyncRecord));
    });
  },
  subscribeDoc(path, cb) {
    if (!db || !currentUid) return () => {};
    const [col, id] = path.split('/');
    return onSnapshot(doc(db, 'users', currentUid, col, id), (snap) => {
      cb(snap.exists() ? snap.data() : null);
    });
  },
};

export async function signIn(email: string, password: string): Promise<void> {
  await signInWithEmailAndPassword(ensureAuth(), email, password);
}

export async function signUp(email: string, password: string): Promise<void> {
  await createUserWithEmailAndPassword(ensureAuth(), email, password);
}

export async function signOutSync(): Promise<void> {
  await signOut(ensureAuth());
}

function activate(): void {
  if (!isFirebaseConfigured || auth) return;
  const app = getApps()[0] ?? initializeApp(firebaseConfig);
  auth = initializeAuth(app, { persistence: indexedDBLocalPersistence });
  db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
  registerSyncBackend(backend);
  // Drives sync on sign-in and on persisted-session restore after a SW wake.
  onAuthStateChanged(auth, (user) => {
    if (user) {
      currentUid = user.uid;
      void startSync(user.uid, user.email);
    } else {
      currentUid = null;
      void stopSync();
    }
  });
}

activate();
