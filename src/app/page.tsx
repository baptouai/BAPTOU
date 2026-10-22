"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { authErrorText, useAuth } from "@/lib/auth-context";
import { LanguageSwitch, useI18n } from "@/lib/i18n";
import { ThemeSwitch } from "@/components/ThemeSwitch";
import { CheckInbox, EmailSignIn, linkButton, posterCard } from "@/components/EmailSignIn";
import { chromeIntentUrl, inAppBrowser, isAndroid } from "@/lib/inAppBrowser";

const never = () => () => {};

/**
 * Inside Instagram's or TikTok's own browser, where Google can't sign in: the email address instead, and a way
 * to open the page in the phone's real browser (Chrome on Android; on iPhone, copy the link or use the ⋯ menu).
 */
function InAppNotice({ app }: { app: string }) {
  const { t } = useI18n();
  const android = useSyncExternalStore(never, isAndroid, () => false);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
    } catch {
      window.prompt(t("Copy this link:"), window.location.href);
    }
  }

  return (
    <div className={`${posterCard} mt-8`} role="note">
      <p className="font-bold text-white">{t("You're in {app}'s browser", { app })}</p>
      <p className="mt-1 text-sm text-indigo-100">
        {t("Google sign-in doesn't work here. Create your account with your email address below, or open BAPTOU in your phone's browser.")}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        {android && (
          <a href={chromeIntentUrl()} className="rounded-full bg-white px-4 py-2 text-sm font-bold text-[#312e81] hover:bg-indigo-50">
            {t("Open in Chrome")}
          </a>
        )}
        <button type="button" onClick={copy} className={linkButton}>
          {t(copied ? "Link copied: paste it in Safari or Chrome" : "Copy the link")}
        </button>
      </div>
      {!android && <p className="mt-2 text-xs text-indigo-200">{t("Or tap ⋯ at the top right, then open in your browser.")}</p>}
    </div>
  );
}

/**
 * The sign-in page, laid out like the Instagram posters: gradient, kicker, heavy headline, white pill.
 * Google, or an email address and a password (confirmed by a link before the app opens).
 */
export default function Home() {
  const { user, unverified, loading, signIn } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  const [error, setError] = useState("");
  // "" while pre-rendering and in a normal browser; the app's name inside Instagram, TikTok...
  const inApp = useSyncExternalStore(never, inAppBrowser, () => "");

  async function google() {
    setError("");
    try {
      await signIn();
    } catch (e) {
      setError(authErrorText(e));
    }
  }

  useEffect(() => {
    if (user) router.replace("/dashboard");
  }, [user, router]);

  return (
    <main className="poster relative flex flex-1 flex-col items-center justify-center overflow-hidden px-5 py-16">
      <ThemeSwitch className="absolute left-4 top-4" />
      <LanguageSwitch className="absolute right-4 top-4" />
      <div className="w-full max-w-xl text-center">
        <div className="rise flex items-center justify-center gap-3 text-2xl font-black tracking-wide">
          <Image src="/logo-white.svg" alt="" width={52} height={52} className="drop-shadow-lg" priority />
          BAPTOU
        </div>
        <p className="rise poster-kicker mt-8" style={{ "--d": "80ms" } as React.CSSProperties}>
          {t("Internships · Jobs · Alternances · Master's")}
        </p>
        <h1 className="rise mt-5 text-5xl leading-[1.04] sm:text-6xl" style={{ "--d": "160ms" } as React.CSSProperties}>
          {t("Your AI agent for")} <span className="poster-hi">{t("applications.")}</span>
        </h1>
        <p className="rise mt-5 text-lg text-indigo-100" style={{ "--d": "240ms" } as React.CSSProperties}>
          {t("It finds offers that fit you, prepares each application and writes your letters. Nothing is sent without your approval.")}
        </p>
        <div className="rise" style={{ "--d": "320ms" } as React.CSSProperties}>
          {unverified ? (
            <CheckInbox />
          ) : inApp ? (
            <>
              <InAppNotice app={inApp} />
              <EmailSignIn key="in-app" startOpen />
            </>
          ) : (
            <>
              <button onClick={google} disabled={loading} className="poster-cta mt-8 w-full px-4 py-3.5 text-lg disabled:opacity-50">
                {t("Continue with Google")} <span aria-hidden>→</span>
              </button>
              {error && <p className="mt-3 rounded-xl bg-rose-500/20 px-3 py-2 text-sm text-rose-100" role="alert">{t(error)}</p>}
              <EmailSignIn />
            </>
          )}
          <p className="mt-4 text-sm text-indigo-200">
            {t("Your first search is free. A plan then prepares your applications and searches every morning.")}
          </p>
        </div>
        <p className="rise mt-8 text-sm text-indigo-200" style={{ "--d": "400ms" } as React.CSSProperties}>
          <a href="https://baptou.com" className="hover:text-white hover:underline">{t("About BAPTOU and pricing")}</a>
          {" · "}
          <a href="https://baptou.com/privacy" className="hover:text-white hover:underline">{t("Privacy policy")}</a>
        </p>
      </div>
    </main>
  );
}
