// Firebase connection for the projectBV dashboard.
// The web-config values are NOT secrets — they only identify the Runic project.
// Access is governed by the Firestore/Storage rules, which now require a
// verified, allow-listed Google account for anything that controls a device.
import { initializeApp } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'
import { getStorage } from 'firebase/storage'
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from 'firebase/auth'

const firebaseConfig = {
  apiKey: 'AIzaSyAVUpYv80vSSZQnNibHOpow8qu-rPTL9lE',
  authDomain: 'runik-77e07.firebaseapp.com',
  projectId: 'runik-77e07',
  storageBucket: 'runik-77e07.firebasestorage.app',
  messagingSenderId: '185862529418',
  appId: '1:185862529418:web:3432a9b435e90cbe66e873',
  measurementId: 'G-07CG6CECCL',
}

const app = initializeApp(firebaseConfig)
export const db = getFirestore(app)
export const storage = getStorage(app)
export const auth = getAuth(app)

const provider = new GoogleAuthProvider()
// Always let the operator choose the account, so a shared machine never silently
// signs in as the wrong Google user.
provider.setCustomParameters({ prompt: 'select_account' })

export function signInWithGoogle() {
  return signInWithPopup(auth, provider)
}

export function signOutUser() {
  return signOut(auth)
}

// Fires once with the current user (or null) and again on every change.
export function watchAuth(cb) {
  return onAuthStateChanged(auth, cb)
}

// Storage rules require an authenticated request. The whole app now sits behind a
// Google login, so by the time anything uploads, a real user is signed in — this
// just hands back that user (no more anonymous sign-in).
export function ensureAuth() {
  return Promise.resolve(auth.currentUser)
}
