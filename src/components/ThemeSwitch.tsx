"use client";

import { useSyncExternalStore } from "react";
import { useI18n } from "@/lib/i18n";

// Light or dark: the user's choice (kept in this browser), otherwise the device's setting, followed live.
// The script in the root layout applies it to <html data-theme> before the first paint, so nothing flashes.
const KEY = "theme";
const EVENT = "baptou-theme";

function stored(): "light" | "dark" | null {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : null;
  } catch {
    return null;
  }
}

function subscribe(onChange: () => void) {
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const followDevice = () => {
    if (stored()) return; // the user's choice wins
    document.documentElement.dataset.theme = mq.matches ? "dark" : "light";
    onChange();
  };
  mq.addEventListener("change", followDevice);
  window.addEventListener(EVENT, onChange);
  return () => {
    mq.removeEventListener("change", followDevice);
    window.removeEventListener(EVENT, onChange);
  };
}

const snapshot = () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

/** The light/dark switch, at the top left of every page. */
export function ThemeSwitch({ className = "" }: { className?: string }) {
  const { t } = useI18n();
  // null on the server (it can't know the theme); the switch appears once the page runs.
  const theme = useSyncExternalStore(subscribe, snapshot, () => null);
  const dark = theme === "dark";

  function toggle() {
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // private browsing: the choice lasts for this page only
    }
    window.dispatchEvent(new Event(EVENT));
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label={t("Dark mode")}
      title={t(dark ? "Switch to light mode" : "Switch to dark mode")}
      onClick={toggle}
      // No position of its own, so a page can place it (e.g. absolute in a corner).
      className={`inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-card-edge bg-background px-0.5 ${theme ? "" : "invisible"} ${className}`}
    >
      <span
        className={`flex h-[18px] w-[18px] items-center justify-center rounded-full bg-accent text-white transition-transform dark:text-[#1e1b4b] ${dark ? "translate-x-5" : ""}`}
      >
        {dark ? (
          // Moon
          <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden>
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
          </svg>
        ) : (
          // Sun
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
            <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </svg>
        )}
      </span>
    </button>
  );
}
