"use client";

import { useEffect, useState } from "react";
import { authErrorText, passwordProblem, useAuth } from "@/lib/auth-context";
import { useI18n } from "@/lib/i18n";

// Signing in without a Google account, on the poster-style pages (sign-in page, links from BAPTOU's emails):
// an email address and a password, confirmed by a link sent to that address before the app opens.

export const posterInput =
  "mt-1 block w-full rounded-xl border border-white/25 bg-white/95 px-4 py-2.5 text-[#1e1b4b] placeholder:text-indigo-300 focus:outline-none focus:ring-2 focus:ring-white/70";
export const posterCard = "mt-4 rounded-2xl border border-white/20 bg-white/10 p-5 text-left shadow-[0_18px_40px_-24px_rgba(0,0,0,0.6)] backdrop-blur";
export const linkButton = "text-sm text-indigo-100 underline-offset-2 hover:text-white hover:underline disabled:opacity-50";

/** A password field with a show / hide switch. */
export function PasswordInput({
  value,
  onChange,
  autoComplete,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  label: string;
}) {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  return (
    <label className="mt-3 block text-sm font-semibold text-indigo-50">
      {label}
      <span className="relative block">
        <input
          type={shown ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          required
          className={`${posterInput} pr-24`}
        />
        <button
          type="button"
          onClick={() => setShown(!shown)}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-2 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-50"
        >
          {t(shown ? "Hide" : "Show")}
        </button>
      </span>
    </label>
  );
}

type Mode = "signin" | "signup" | "reset";

/**
 * "Continue with an email address": sign in, create an account, or get a link to choose a new password.
 * `startOpen` shows the form at once on "Create an account" (inside Instagram or TikTok, where Google can't sign in).
 */
export function EmailSignIn({ startOpen = false }: { startOpen?: boolean }) {
  const { signInWithEmail, signUpWithEmail, resetPassword, pendingGoogle } = useAuth();
  const { t } = useI18n();
  const [open, setOpen] = useState(startOpen);
  const [mode, setMode] = useState<Mode>(startOpen ? "signup" : "signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Google found an account with a password at this address: sign in with it once, and Google is added to it.
  const [shownFor, setShownFor] = useState(pendingGoogle);
  if (pendingGoogle !== shownFor) {
    setShownFor(pendingGoogle);
    if (pendingGoogle) {
      setOpen(true);
      setMode("signin");
      setEmail(pendingGoogle.email);
      setError("");
      setNotice("An account with a password already uses this address. Sign in with your password once: Google will then be added to it.");
    }
  }

  function switchTo(next: Mode) {
    setMode(next);
    setError("");
    setNotice("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (mode === "signup") {
      const problem = passwordProblem(password);
      if (problem) return setError(problem);
    }
    setBusy(true);
    try {
      if (mode === "signin") await signInWithEmail(email, password);
      else if (mode === "signup") await signUpWithEmail(email, password);
      else {
        await resetPassword(email);
        setNotice("If an account uses this address, we've sent it a link to choose a new password. Check your spam folder too.");
      }
    } catch (err) {
      setError(authErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <>
        <div className="mt-5 flex items-center gap-3 text-xs font-semibold uppercase tracking-widest text-indigo-200" aria-hidden>
          <span className="h-px flex-1 bg-white/20" />
          {t("or")}
          <span className="h-px flex-1 bg-white/20" />
        </div>
        <button
          onClick={() => setOpen(true)}
          className="mt-5 w-full rounded-full border border-white/40 px-4 py-3 font-semibold text-white hover:bg-white/10"
        >
          {t("Continue with an email address")}
        </button>
      </>
    );
  }

  return (
    <form onSubmit={submit} className={posterCard}>
      {mode !== "reset" ? (
        <div className="flex gap-1 rounded-full border border-white/25 p-1 text-sm" role="tablist">
          {(["signin", "signup"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => switchTo(m)}
              className={`flex-1 rounded-full px-3 py-1.5 font-semibold ${mode === m ? "bg-white text-[#312e81]" : "text-indigo-100 hover:text-white"}`}
            >
              {t(m === "signin" ? "Sign in" : "Create an account")}
            </button>
          ))}
        </div>
      ) : (
        <>
          <p className="font-bold text-white">{t("Choose a new password")}</p>
          <p className="mt-1 text-sm text-indigo-100">{t("Enter your account's email address: we'll send you a link to choose a new password.")}</p>
        </>
      )}

      <label className="mt-4 block text-sm font-semibold text-indigo-50">
        {t("Email address")}
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          inputMode="email"
          required
          className={posterInput}
        />
      </label>

      {mode !== "reset" && (
        <PasswordInput
          value={password}
          onChange={setPassword}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          label={t("Password")}
        />
      )}
      {mode === "signup" && <p className="mt-1.5 text-xs text-indigo-200">{t("At least 10 characters, with a letter and a digit.")}</p>}

      {notice && <p className="mt-3 rounded-xl bg-emerald-400/15 px-3 py-2 text-sm text-emerald-100" role="status">{t(notice)}</p>}
      {error && <p className="mt-3 rounded-xl bg-rose-500/20 px-3 py-2 text-sm text-rose-100" role="alert">{t(error)}</p>}

      <button type="submit" disabled={busy} className="poster-cta mt-4 w-full px-4 py-3 disabled:opacity-50">
        {t(busy ? "One moment…" : mode === "signin" ? "Sign in" : mode === "signup" ? "Create my account" : "Send the link")}
      </button>

      <div className="mt-3 flex flex-wrap justify-between gap-2">
        {mode === "signin" && (
          <button type="button" onClick={() => switchTo("reset")} className={linkButton}>
            {t("Forgot your password?")}
          </button>
        )}
        {mode === "reset" && (
          <button type="button" onClick={() => switchTo("signin")} className={linkButton}>
            {t("← Back to sign in")}
          </button>
        )}
        {mode === "signup" && <p className="text-xs text-indigo-200">{t("We'll send a link to this address to confirm it's yours.")}</p>}
      </div>
    </form>
  );
}

/** After signing up with an email address: until the link in the email is opened, only this screen. */
export function CheckInbox() {
  const { unverified, resendVerification, checkVerified, logOut } = useAuth();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [waitUntil, setWaitUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  // The link is usually opened in another tab or on the phone: look again every few seconds and when the
  // student comes back to this tab.
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === "visible") checkVerified().catch(() => {});
    };
    const timer = window.setInterval(() => {
      setNow(Date.now());
      check();
    }, 5000);
    window.addEventListener("focus", check);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [checkVerified]);

  async function confirmNow() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (!(await checkVerified())) setNotice("Not confirmed yet. Open the link in the email first.");
    } catch (e) {
      setError(authErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await resendVerification();
      setNotice("Sent again. It can take a minute to arrive.");
      setWaitUntil(Date.now() + 60_000);
      setNow(Date.now());
    } catch (e) {
      setError(authErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  const wait = Math.max(0, Math.ceil((waitUntil - now) / 1000));
  return (
    <div className={`${posterCard} mt-8`}>
      <p className="text-xl font-black text-white">{t("Check your inbox")}</p>
      <p className="mt-2 text-indigo-50">
        {t("We've sent a link to {email}. Open it to confirm your address: BAPTOU opens right after.", { email: unverified?.email ?? "" })}
      </p>
      <p className="mt-2 text-sm text-indigo-200">{t("Nothing after a few minutes? Look in your spam folder, or send it again.")}</p>
      {notice && <p className="mt-3 rounded-xl bg-emerald-400/15 px-3 py-2 text-sm text-emerald-100" role="status">{t(notice)}</p>}
      {error && <p className="mt-3 rounded-xl bg-rose-500/20 px-3 py-2 text-sm text-rose-100" role="alert">{t(error)}</p>}
      <button onClick={confirmNow} disabled={busy} className="poster-cta mt-4 w-full px-4 py-3 disabled:opacity-50">
        {t("I've confirmed my address")}
      </button>
      <div className="mt-3 flex flex-wrap justify-between gap-2">
        <button onClick={resend} disabled={busy || wait > 0} className={linkButton}>
          {wait > 0 ? t("Send again in {n} s", { n: wait }) : t("Send the email again")}
        </button>
        <button onClick={() => logOut()} disabled={busy} className={linkButton}>
          {t("Use another address")}
        </button>
      </div>
    </div>
  );
}
