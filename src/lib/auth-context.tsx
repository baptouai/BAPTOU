"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  type AuthCredential,
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  linkWithCredential,
  onIdTokenChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import { FirebaseError } from "firebase/app";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { auth, db, googleProvider } from "./firebase";

type AuthState = {
  /** Signed in and allowed in the app: a Google account, or an email account whose address is confirmed. */
  user: User | null;
  /** Signed in with an email and a password whose address isn't confirmed yet: only the "check your inbox" screen. */
  unverified: User | null;
  loading: boolean;
  /** A Google sign-in waiting for the password of the BAPTOU account that already uses its address (see signIn). */
  pendingGoogle: { email: string } | null;
  signIn: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signUpWithEmail: (email: string, password: string) => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  resendVerification: () => Promise<void>;
  /** Asks Firebase again whether the address is confirmed (the link may have been opened in another tab); if so, opens the app. */
  checkVerified: () => Promise<boolean>;
  logOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

// Where the links in the confirmation and new-password emails lead back to.
const linkSettings = () => ({ url: `${window.location.origin}/` });

/** BAPTOU's password rule (also Firebase Auth's password policy): at least 10 characters, a letter and a digit. */
export function passwordProblem(password: string) {
  if (password.length < 10) return "Use at least 10 characters.";
  if (!/\p{L}/u.test(password) || !/\d/.test(password)) return "Use at least one letter and one digit.";
  return null;
}

/** A sign-in error as a message for the student (English; show it with t()). Empty: nothing to say. */
export function authErrorText(e: unknown) {
  if (!(e instanceof FirebaseError)) return e instanceof Error && e.message ? e.message : "Something went wrong";
  switch (e.code) {
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
    case "auth/user-cancelled":
      return "";
    case "auth/invalid-credential":
    case "auth/invalid-login-credentials":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "Wrong email address or password.";
    case "auth/invalid-email":
    case "auth/missing-email":
      return "This email address isn't valid.";
    case "auth/missing-password":
      return "Enter your password.";
    case "auth/email-already-in-use":
      return "An account already uses this address. Sign in (with Google if you created it that way), or choose “Forgot your password?” to set one.";
    case "auth/weak-password":
    case "auth/password-does-not-meet-requirements":
      return "Use at least 10 characters, with at least one letter and one digit.";
    case "auth/too-many-requests":
      return "Too many attempts. Wait a few minutes, or reset your password.";
    case "auth/user-disabled":
      return "This account has been disabled. Write to baptouai@gmail.com.";
    case "auth/network-request-failed":
      return "No connection. Check your network and try again.";
    case "auth/popup-blocked":
      return "Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.";
    case "auth/expired-action-code":
    case "auth/invalid-action-code":
      return "This link has expired or was already used.";
    case "auth/credential-already-in-use":
      return "This Google account is already linked to another BAPTOU account.";
    case "auth/operation-not-allowed":
      return "Signing in with an email address isn't available right now. Use Google, or try again later.";
    default:
      return "Something went wrong";
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // A new object on every change (token refresh, address confirmed): Firebase keeps the same User object, so
  // this is what makes the app see the change.
  const [state, setState] = useState<{ user: User | null; verified: boolean }>({ user: null, verified: false });
  const [loading, setLoading] = useState(true);
  const [pendingGoogle, setPendingGoogle] = useState<{ email: string } | null>(null);
  const googleCredential = useRef<AuthCredential | null>(null);
  const seen = useRef<string | null>(null);

  useEffect(
    () =>
      onIdTokenChanged(auth, (u) => {
        setState({ user: u, verified: !!u?.emailVerified });
        setLoading(false);
      }),
    [],
  );

  const user = state.user && state.verified ? state.user : null;
  const unverified = state.user && !state.verified ? state.user : null;

  // Once per page load and account: the basics the app shows, and when the student was last here.
  useEffect(() => {
    if (!user || seen.current === user.uid) return;
    seen.current = user.uid;
    setDoc(doc(db, "users", user.uid), { email: user.email, displayName: user.displayName, lastSeenAt: serverTimestamp() }, { merge: true }).catch(
      () => {},
    );
  }, [user]);

  /** Adds the waiting Google sign-in to the account just signed in with its password, when the address matches. */
  async function linkPendingGoogle(signedIn: User) {
    const credential = googleCredential.current;
    if (!credential || !pendingGoogle || signedIn.email?.toLowerCase() !== pendingGoogle.email.toLowerCase()) return;
    googleCredential.current = null;
    setPendingGoogle(null);
    await linkWithCredential(signedIn, credential).catch(() => {}); // signing in worked; Google can be linked another time
  }

  const checkVerified = useCallback(async () => {
    const current = auth.currentUser;
    if (!current) return false;
    await current.reload();
    if (!current.emailVerified) return false;
    await current.getIdToken(true); // the database rules and the server read "confirmed" from the token
    // Then a fresh page load into the app. Switching over in place kept the database connection on the old,
    // unconfirmed sign-in (seen in production on 19 Oct 2026): nothing was saved until the page was reloaded.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full load is the point
    window.location.assign("/dashboard");
    return true;
  }, []);

  const value: AuthState = {
    user,
    unverified,
    loading,
    pendingGoogle,
    signIn: async () => {
      try {
        await signInWithPopup(auth, googleProvider);
      } catch (e) {
        // One account per address: when an account with a password already uses this Google account's address,
        // the student signs in once with that password, and Google is then added to the same account.
        if (e instanceof FirebaseError && e.code === "auth/account-exists-with-different-credential") {
          const credential = GoogleAuthProvider.credentialFromError(e);
          const email = e.customData?.email as string | undefined;
          if (credential && email) {
            googleCredential.current = credential;
            setPendingGoogle({ email });
            return;
          }
        }
        throw e;
      }
    },
    signInWithEmail: async (email, password) => {
      const { user: signedIn } = await signInWithEmailAndPassword(auth, email.trim(), password);
      await linkPendingGoogle(signedIn);
    },
    signUpWithEmail: async (email, password) => {
      const problem = passwordProblem(password);
      if (problem) throw new Error(problem);
      const { user: created } = await createUserWithEmailAndPassword(auth, email.trim(), password);
      // The account exists even if the email can't go out right now: the next screen sends it again.
      await sendEmailVerification(created, linkSettings()).catch(() => {});
    },
    resetPassword: async (email) => {
      await sendPasswordResetEmail(auth, email.trim(), linkSettings());
    },
    resendVerification: async () => {
      if (auth.currentUser) await sendEmailVerification(auth.currentUser, linkSettings());
    },
    checkVerified,
    logOut: async () => {
      googleCredential.current = null;
      setPendingGoogle(null);
      seen.current = null;
      await signOut(auth);
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
