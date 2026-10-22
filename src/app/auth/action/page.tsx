"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { applyActionCode, checkActionCode, confirmPasswordReset, signInWithEmailAndPassword, verifyPasswordResetCode } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { authErrorText, passwordProblem, useAuth } from "@/lib/auth-context";
import { LanguageSwitch, useI18n } from "@/lib/i18n";
import { ThemeSwitch } from "@/components/ThemeSwitch";
import { linkButton, PasswordInput, posterCard } from "@/components/EmailSignIn";

// Where the links in Firebase Auth's emails lead (the project's action URL is set to this page):
// ?mode=verifyEmail | resetPassword | recoverEmail | verifyAndChangeEmail, with a one-time oobCode.

export default function AuthActionPage() {
  return (
    <main className="poster relative flex flex-1 flex-col items-center justify-center overflow-hidden px-5 py-16">
      <ThemeSwitch className="absolute left-4 top-4" />
      <LanguageSwitch className="absolute right-4 top-4" />
      <div className="w-full max-w-md">
        <div className="flex items-center justify-center gap-3 text-2xl font-black tracking-wide">
          <Image src="/logo-white.svg" alt="" width={44} height={44} className="drop-shadow-lg" priority />
          BAPTOU
        </div>
        <Suspense fallback={null}>
          <Action />
        </Suspense>
      </div>
    </main>
  );
}

type View =
  | { kind: "working" }
  | { kind: "verified"; signedIn: boolean }
  | { kind: "newPassword"; email: string }
  | { kind: "passwordSaved" }
  | { kind: "restored"; email: string }
  | { kind: "emailChanged" }
  | { kind: "error"; message: string };

function Action() {
  const params = useSearchParams();
  const mode = params.get("mode") ?? "";
  const code = params.get("oobCode") ?? "";
  const { t } = useI18n();
  const { checkVerified } = useAuth();
  const [view, setView] = useState<View>({ kind: "working" });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // a code works only once (and React runs effects twice in development)
    started.current = true;
    (async () => {
      try {
        await auth.authStateReady(); // whether this browser is signed in (to the account being confirmed)
        if (!code) return setView({ kind: "error", message: "This link isn't valid." });
        if (mode === "verifyEmail") {
          try {
            await applyActionCode(auth, code);
          } catch (e) {
            // Some mail services open links before the student does: an address already confirmed is fine.
            if (!(await checkVerified().catch(() => false))) throw e;
          }
          // Signed in on this browser: checkVerified opens the app (a fresh page load). Otherwise, sign in.
          const signedIn = await checkVerified().catch(() => false);
          setView({ kind: "verified", signedIn });
        } else if (mode === "resetPassword") {
          setView({ kind: "newPassword", email: await verifyPasswordResetCode(auth, code) });
        } else if (mode === "recoverEmail") {
          const info = await checkActionCode(auth, code);
          await applyActionCode(auth, code);
          setView({ kind: "restored", email: info.data.email ?? "" });
        } else if (mode === "verifyAndChangeEmail") {
          await applyActionCode(auth, code);
          setView({ kind: "emailChanged" });
        } else {
          setView({ kind: "error", message: "This link isn't valid." });
        }
      } catch (e) {
        setView({ kind: "error", message: authErrorText(e) || "Something went wrong" });
      }
    })();
  }, [mode, code, checkVerified]);

  const done = (title: string, text: string, href = "/", button = "Continue to BAPTOU") => (
    <div className={posterCard}>
      <p className="text-xl font-black text-white">{t(title)}</p>
      <p className="mt-2 text-indigo-50">{text}</p>
      {/* A full page load (not a client-side link), so the app starts with the account's current sign-in. */}
      <a href={href} className="poster-cta mt-4 block w-full px-4 py-3 text-center">
        {t(button)}
      </a>
    </div>
  );

  switch (view.kind) {
    case "working":
      return <p className="mt-8 text-center text-indigo-100">{t("One moment…")}</p>;
    case "verified":
      return view.signedIn
        ? done("Your address is confirmed", t("Welcome to BAPTOU! Opening the app…"), "/dashboard", "Open BAPTOU")
        : done("Your address is confirmed", t("You can now sign in with your email address and password."), "/", "Sign in");
    case "newPassword":
      return <NewPassword email={view.email} code={code} onSaved={() => setView({ kind: "passwordSaved" })} />;
    case "passwordSaved":
      return done("Your new password is saved", t("You're signed in with it."));
    case "restored":
      return done(
        "Your address is restored",
        t("Your account uses {email} again. If you didn't ask for the change, choose a new password from the sign-in page (“Forgot your password?”).", {
          email: view.email,
        }),
      );
    case "emailChanged":
      return done("Your new address is confirmed", t("Sign in with it from now on."));
    case "error":
      return done("This link can't be used", t(view.message), "/", "Back to BAPTOU");
  }
}

/** The form behind a "choose a new password" link. Signs the student in once the password is saved. */
function NewPassword({ email, code, onSaved }: { email: string; code: string; onSaved: () => void }) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const problem = passwordProblem(password);
    if (problem) return setError(problem);
    setBusy(true);
    setError("");
    try {
      await confirmPasswordReset(auth, code, password);
      await signInWithEmailAndPassword(auth, email, password).catch(() => {});
      onSaved();
    } catch (err) {
      setError(authErrorText(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className={posterCard}>
      <p className="text-xl font-black text-white">{t("Choose a new password")}</p>
      <p className="mt-2 text-sm text-indigo-100">{t("For {email}.", { email })}</p>
      {/* Lets password managers save the new password for the right account. */}
      <input type="email" value={email} autoComplete="username" readOnly hidden />
      <PasswordInput value={password} onChange={setPassword} autoComplete="new-password" label={t("New password")} />
      <p className="mt-1.5 text-xs text-indigo-200">{t("At least 10 characters, with a letter and a digit.")}</p>
      {error && <p className="mt-3 rounded-xl bg-rose-500/20 px-3 py-2 text-sm text-rose-100" role="alert">{t(error)}</p>}
      <button type="submit" disabled={busy} className="poster-cta mt-4 w-full px-4 py-3 disabled:opacity-50">
        {t(busy ? "One moment…" : "Save my new password")}
      </button>
      <Link href="/" className={`${linkButton} mt-3 inline-block`}>
        {t("← Back to sign in")}
      </Link>
    </form>
  );
}
