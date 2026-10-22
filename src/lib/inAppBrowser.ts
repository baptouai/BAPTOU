// Instagram, TikTok, Facebook and Snapchat open links in their own built-in browser. Google refuses to sign in
// there ("disallowed_useragent") and their pop-ups often fail, so the sign-in page offers the email address
// instead and helps the student open the page in their real browser. Most students arrive from those apps' ads.

const APPS: [RegExp, string][] = [
  [/Instagram/i, "Instagram"],
  [/FBAN|FBAV|FB_IAB|FBIOS/, "Facebook"],
  [/musical_ly|BytedanceWebview|TikTok|trill_/i, "TikTok"],
  [/Snapchat/i, "Snapchat"],
  [/LinkedInApp/i, "LinkedIn"],
];

/** The app whose built-in browser shows this page (e.g. "Instagram"), or "" in a normal browser. */
export function inAppBrowser(): string {
  if (typeof navigator === "undefined") return "";
  // For checking the page locally: ?inapp=Instagram (only outside production builds).
  if (process.env.NODE_ENV !== "production") {
    const forced = new URLSearchParams(window.location.search).get("inapp");
    if (forced) return forced;
  }
  return APPS.find(([re]) => re.test(navigator.userAgent))?.[1] ?? "";
}

/** True on Android, where a link can ask Chrome to open the page. */
export function isAndroid() {
  if (typeof navigator === "undefined") return false;
  if (process.env.NODE_ENV !== "production" && new URLSearchParams(window.location.search).get("android")) return true;
  return /Android/i.test(navigator.userAgent);
}

/** A link that opens the current page in Chrome from an Android in-app browser (falls back to the same page). */
export function chromeIntentUrl() {
  const { host, pathname, search, href } = window.location;
  return `intent://${host}${pathname}${search}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(href)};end`;
}
