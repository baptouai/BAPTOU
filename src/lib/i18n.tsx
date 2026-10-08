"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { db } from "./firebase";
import { useAuth } from "./auth-context";
import { fr, frPatterns } from "./fr";

// The app's interface languages. Texts are written in English in the code and looked up in the French
// dictionary (src/lib/fr.ts) by their English wording; anything missing there shows in English.
export type Lang = "en" | "fr";
const STORAGE_KEY = "baptou.lang";

type Vars = Record<string, string | number>;
type I18n = {
  lang: Lang;
  setLang: (lang: Lang) => void;
  /** Translates an English text; `{name}` placeholders are filled from `vars`. */
  t: (text: string, vars?: Vars) => string;
  /** A date in the interface language, e.g. 7 October 2026 / 7 octobre 2026. */
  date: (d: Date | number | string, style?: "long" | "short") => string;
  /**
   * A calendar day stored as a date (a deadline, an opening date, "2026-11-02"): shown as that same day
   * wherever the student is, not shifted by their time zone.
   */
  day: (d: Date | number | string, style?: "long" | "short") => string;
  /** A date and time in the interface language. */
  dateTime: (d: Date | number) => string;
};

const fill = (text: string, vars?: Vars) =>
  vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text;

/** This device's language: the one chosen here before, otherwise the browser's. */
function deviceLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "fr") return saved;
  } catch {
    // Storage unavailable: fall back to the browser's language.
  }
  return navigator.language?.toLowerCase().startsWith("fr") ? "fr" : "en";
}
const CHANGED = "baptou-lang";
const subscribe = (onChange: () => void) => {
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
};

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  // English while pre-rendering, so the static HTML matches the first render; then this device's language.
  const device = useSyncExternalStore(subscribe, deviceLang, () => "en" as Lang);
  const [account, setAccount] = useState<{ uid: string; lang: Lang } | null>(null);

  // The account's language wins once signed in (it follows the user across devices), and the server
  // uses it for BAPTOU's emails and the explanations it writes.
  useEffect(() => {
    if (!user) return;
    return onSnapshot(doc(db, "users", user.uid), (snap) => {
      const saved = snap.get("lang");
      if (saved === "en" || saved === "fr") setAccount({ uid: user.uid, lang: saved });
      else setDoc(doc(db, "users", user.uid), { lang: deviceLang() }, { merge: true }).catch(() => {});
    });
  }, [user]);
  const lang: Lang = user && account?.uid === user.uid ? account.lang : device;

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback(
    (next: Lang) => {
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Not saved on this device; the account setting below still applies.
      }
      window.dispatchEvent(new Event(CHANGED));
      if (user) {
        setAccount({ uid: user.uid, lang: next });
        setDoc(doc(db, "users", user.uid), { lang: next }, { merge: true }).catch(() => {});
      }
    },
    [user],
  );

  const value = useMemo<I18n>(() => {
    const locale = lang === "fr" ? "fr-FR" : "en-GB";
    return {
      lang,
      setLang,
      t: (text, vars) => fill(lang === "fr" ? (fr[text] ?? text) : text, vars),
      date: (d, style = "long") =>
        new Date(d).toLocaleDateString(locale, style === "long" ? { day: "numeric", month: "long", year: "numeric" } : undefined),
      day: (d, style = "short") =>
        new Date(d).toLocaleDateString(locale, {
          ...(style === "long" ? { day: "numeric", month: "long", year: "numeric" } : {}),
          timeZone: "UTC",
        }),
      dateTime: (d) => new Date(d).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" }),
    };
  }, [lang, setLang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}

/** The message of an error from BAPTOU's server or Firebase, in the interface language. */
export function errorText(e: unknown, t: I18n["t"]) {
  if (!(e instanceof Error) || !e.message) return t("Something went wrong");
  const message = e.message.replace(/^Firebase: /, "");
  const translated = t(message);
  if (translated !== message || t("Cancel") === "Cancel") return translated; // found, or English
  // Messages with a variable part, e.g. the reason a posting looks closed.
  for (const [pattern, french] of frPatterns) {
    const m = message.match(pattern);
    if (m) return french.replace(/\$(\d)/g, (_, i: string) => t(m[Number(i)] ?? ""));
  }
  return message;
}

/** EN / FR switch. */
export function LanguageSwitch({ className = "" }: { className?: string }) {
  const { lang, setLang } = useI18n();
  return (
    <div className={`flex items-center gap-0.5 rounded-lg border border-border p-0.5 text-xs ${className}`} role="group" aria-label="Language / Langue">
      {(["en", "fr"] as const).map((l) => (
        <button
          key={l}
          onClick={() => setLang(l)}
          aria-pressed={lang === l}
          className={`rounded-md px-1.5 py-0.5 font-medium uppercase ${lang === l ? "bg-accent text-white" : "text-muted hover:text-foreground"}`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
