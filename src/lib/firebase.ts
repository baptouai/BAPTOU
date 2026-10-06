import { getApp, getApps, initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, GoogleAuthProvider, signInWithCustomToken } from "firebase/auth";
import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";
import { getFunctions } from "firebase/functions";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

export const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);
// BAPTOU uses a named Firestore database ("baptou"), not "(default)".
export const db = getFirestore(app, process.env.NEXT_PUBLIC_FIRESTORE_DATABASE_ID ?? "(default)");
export const storage = getStorage(app);
export const functions = getFunctions(app, "europe-west1");

// Local layout checks (`npm run dev:emulators`): local Auth and Firestore emulators with a test account,
// so pages can be checked without a real Google sign-in. Never set in production builds.
if (process.env.NEXT_PUBLIC_USE_EMULATORS === "1" && typeof window !== "undefined") {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  // The Auth emulator accepts unsigned custom tokens: sign in as an emulator account by its uid.
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  (window as unknown as { testSignIn: (uid: string) => unknown }).testSignIn = (uid) => {
    const now = Math.floor(Date.now() / 1000);
    const aud = "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit";
    const claims = { iss: "emulator@baptou.test", sub: "emulator@baptou.test", aud, uid, iat: now, exp: now + 3600 };
    return signInWithCustomToken(auth, `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.`);
  };
}

// Plain sign-in only. Gmail permissions are requested separately, server-side,
// when the user enables email sending (so we can get a refresh token).
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });
