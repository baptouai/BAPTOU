// BAPTOU Admin's commands: everything the window can ask for, read and written in Firestore with the
// Firebase CLI login (`npx firebase login`). Loaded by main.mjs, and reloaded when this file changes, so
// a new version takes effect without restarting the app.
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const auth = require(join(here, "..", "node_modules", "firebase-tools", "lib", "auth.js"));

const PROJECT = "baptou-5041c";
const DB = `projects/${PROJECT}/databases/baptou`;
const BASE = `https://firestore.googleapis.com/v1/${DB}/documents`;
const DEFAULT_LIMIT = 11; // €10 allowance; keep in sync with PLAN_BUDGET_USD in functions/src/shared.ts
const TRIAL_DAILY_CAP = 30; // new free searches per day unless config/app.trialDailyCap; keep in sync with functions/src/shared.ts
const GMAIL_READ_CAP = 100; // keep in sync with functions/src/access.ts
const SENDER = "baptouai@gmail.com"; // BAPTOU's own mailbox, which sends its emails to users
const REGION = "europe-west1";
// Current prices (src/lib/plan.ts), for the revenue estimate only.
const PRICE_EUR = { monthly: 12.49, annual: 11.49, pass: 12.49 };
const month = () => new Date().toISOString().slice(0, 7);

// --- Firestore REST with the Firebase CLI's credentials

let cached = { token: "", until: 0 };
async function accessToken() {
  if (Date.now() < cached.until) return cached.token;
  const account = auth.getGlobalDefaultAccount();
  if (!account) throw new Error("Not logged in to Firebase. Run: npx firebase login");
  const { access_token } = await auth.getAccessToken(account.tokens.refresh_token, []);
  cached = { token: access_token, until: Date.now() + 30 * 60_000 };
  return access_token;
}

async function fs(path, init = {}) {
  const res = await fetch(`${BASE}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? {} : res.json();
}

async function query(structuredQuery) {
  const res = await fetch(`${BASE}:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery }),
  });
  if (!res.ok) throw new Error(`Firestore ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).filter((r) => r.document).map((r) => r.document);
}

async function list(collection) {
  const docs = [];
  let pageToken = "";
  do {
    const page = await fs(`${collection}?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ""}`);
    docs.push(...(page?.documents ?? []));
    pageToken = page?.nextPageToken ?? "";
  } while (pageToken);
  return docs;
}

const id = (doc) => doc.name.split("/").pop();
const num = (v) => (v ? Number(v.doubleValue ?? v.integerValue ?? 0) : undefined);
const str = (v) => v?.stringValue;
const counts = (map) => Object.fromEntries(Object.entries(map?.mapValue?.fields ?? {}).map(([k, v]) => [k, num(v) ?? 0]));

// --- Users, subscribers, allowances

async function overview() {
  const [users, priv, access, slots, mailer, trialEmails, trialToday, appConfig] = await Promise.all([
    list("users"),
    list("private"),
    list("access"),
    fs("config/gmailRead"),
    fs("config/mailer"),
    list("trialEmails"), // one per address that took the free search, kept after account deletion
    fs(`trialDays/${new Date().toISOString().slice(0, 10)}`),
    fs("config/app"),
  ]);
  const privById = Object.fromEntries(priv.map((d) => [id(d), d.fields ?? {}]));
  const gifts = Object.fromEntries(access.map((d) => [decodeURIComponent(id(d)), d.fields ?? {}]));
  const m = month();
  const now = Date.now();
  const live = (ts) => !ts || Date.parse(ts) > now;

  const rows = users.map((u) => {
    const f = u.fields ?? {};
    const p = privById[id(u)] ?? {};
    const email = (str(f.email) ?? "").toLowerCase();
    const personal = num(p.monthlyLimitUsd);
    const plan = p.plan?.mapValue?.fields;
    const planEnd = plan?.currentPeriodEnd?.timestampValue;
    const planActive = plan && ["active", "past_due"].includes(str(plan.status)) && live(planEnd);
    const gift = gifts[email];
    const giftEnd = gift?.expiresAt?.timestampValue ?? null;
    const trial = p.trial?.mapValue?.fields;
    // Same order as the server (functions/src/shared.ts entitlementFor): owner, paid plan, gift.
    const access =
      personal != null
        ? { kind: "owner", until: null }
        : planActive
          ? { kind: str(plan.type), until: planEnd ?? null, cancelling: plan.cancelAtPeriodEnd?.booleanValue === true }
          : gift && live(giftEnd)
            ? { kind: "gift", until: giftEnd }
            : gift
              ? { kind: "gift expired", until: giftEnd }
              : { kind: "none", until: null };
    const limitUsd = personal ?? (access.kind === "none" || access.kind === "gift expired" ? null : (num(gift?.monthlyLimitUsd) ?? DEFAULT_LIMIT));
    return {
      uid: id(u),
      email,
      name: str(f.displayName) ?? "",
      createdAt: u.createTime ?? null,
      lastSeenAt: f.lastSeenAt?.timestampValue ?? null,
      access,
      // A free search refused because the address already had one (sameEmail) isn't a free search.
      trial: trial && trial.sameEmail?.booleanValue !== true ? { started: true, used: !!trial.usedAt?.timestampValue } : null,
      trialRefused: trial?.sameEmail?.booleanValue === true,
      // Free searches from before 19 Oct 2026 have no per-address record (trialEmails).
      trialLegacy: !!trial && trial.sameEmail?.booleanValue !== true && !trial.emailKey,
      hasGift: !!gift,
      isOwner: personal != null,
      limitUsd,
      spentUsd: num(p.spendUsd?.mapValue?.fields?.[m]) ?? 0,
      gmail: !!str(f.gmail?.mapValue?.fields?.email),
      gmailRead: p.gmailRead?.booleanValue === true,
    };
  });

  // Subscribers: paying plans by type, gifts, free searches, accounts.
  const kinds = (k) => rows.filter((r) => r.access.kind === k).length;
  const paying = { monthly: kinds("monthly"), annual: kinds("annual"), pass: kinds("pass") };
  const day = 86_400_000;
  const subscribers = {
    paying: paying.monthly + paying.annual + paying.pass,
    byPlan: paying,
    cancelling: rows.filter((r) => r.access.cancelling).length,
    gifted: kinds("gift"),
    trialStarted: rows.filter((r) => r.trial).length,
    trialUsed: rows.filter((r) => r.trial?.used).length,
    // Everyone who ever took the free search, deleted accounts included.
    trialAllTime: trialEmails.length + rows.filter((r) => r.trialLegacy).length,
    trialThenPaid: rows.filter((r) => r.trial && ["monthly", "annual", "pass"].includes(r.access.kind)).length,
    trialToday: num(trialToday?.fields?.started) ?? 0,
    trialDailyCap: num(appConfig?.fields?.trialDailyCap) ?? TRIAL_DAILY_CAP,
    accounts: rows.filter((r) => !r.isOwner).length,
    newThisWeek: rows.filter((r) => !r.isOwner && r.createdAt && now - Date.parse(r.createdAt) < 7 * day).length,
    activeThisWeek: rows.filter((r) => !r.isOwner && r.lastSeenAt && now - Date.parse(r.lastSeenAt) < 7 * day).length,
    revenueEur: Math.round((paying.monthly * PRICE_EUR.monthly + paying.annual * PRICE_EUR.annual + paying.pass * PRICE_EUR.pass) * 100) / 100,
  };

  const known = new Set(rows.map((r) => r.email));
  const pending = Object.entries(gifts)
    .filter(([email]) => !known.has(email))
    .map(([email, f]) => ({
      email,
      until: f.expiresAt?.timestampValue ?? null,
      notifiedAt: f.notifiedAt?.timestampValue ?? null,
      notifyError: str(f.notifyError) ?? null,
      sending: f.notify?.booleanValue === true,
    }));
  return {
    month: m,
    defaultLimit: DEFAULT_LIMIT,
    gmailRead: { granted: num(slots?.fields?.granted) ?? 0, cap: GMAIL_READ_CAP },
    sender: {
      expected: SENDER,
      email: str(mailer?.fields?.email) ?? null,
      connectedAt: mailer?.fields?.connectedAt?.timestampValue ?? null,
      error: str(mailer?.fields?.error) ?? null,
    },
    subscribers,
    users: rows,
    pending,
  };
}

// --- Website visits (counted by the siteHit function, see functions/src/siteStats.ts)

async function visits() {
  const days = [];
  for (let i = 29; i >= 0; i--) days.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10));
  const [stats, recent] = await Promise.all([
    list("siteStats"),
    query({ from: [{ collectionId: "siteVisits" }], orderBy: [{ field: { fieldPath: "at" }, direction: "DESCENDING" }], limit: 40 }),
  ]);
  const byDay = Object.fromEntries(stats.map((d) => [id(d), d.fields ?? {}]));
  const series = days.map((date) => {
    const f = byDay[date] ?? {};
    // fresh: new people (a browser's first visit; counted since 19 Oct 2026). seconds / newSeconds: time the pages
    // were on screen, for all visits and for visits that started as a new person, and timedVisits /
    // timedNewVisitors: the visits whose pages report that time (measured since 20 Oct 2026).
    return {
      date,
      views: num(f.views) ?? 0,
      visits: num(f.visits) ?? 0,
      fresh: num(f.newVisitors) ?? 0,
      seconds: num(f.seconds) ?? 0,
      newSeconds: num(f.newSeconds) ?? 0,
      timedVisits: num(f.timedVisits) ?? 0,
      timedFresh: num(f.timedNewVisitors) ?? 0,
    };
  });
  const sum = (from, key) => series.slice(from).reduce((s, d) => s + d[key], 0);
  // Average seconds on screen per new person (all their pages) and per visit; null: nothing measured yet.
  const per = (secs, n) => (n ? Math.round(secs / n) : null);
  const time = (from) => ({
    perNew: per(sum(from, "newSeconds"), sum(from, "timedFresh")),
    perVisit: per(sum(from, "seconds"), sum(from, "timedVisits")),
  });
  const top = (field) => {
    const total = {};
    for (const date of days) for (const [k, v] of Object.entries(counts(byDay[date]?.[field]))) total[k] = (total[k] ?? 0) + v;
    return Object.entries(total)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, n]) => ({ name, n }));
  };
  const rows = recent.map((d) => ({
    at: d.fields?.at?.timestampValue ?? null,
    path: str(d.fields?.path) ?? "/",
    from: str(d.fields?.from) ?? null,
    device: str(d.fields?.device) ?? "",
    fresh: d.fields?.new?.booleanValue === true,
  }));
  const fiveMin = Date.now() - 5 * 60_000;
  return {
    today: { views: series[29].views, visits: series[29].visits, fresh: series[29].fresh, ...time(29) },
    week: { views: sum(23, "views"), visits: sum(23, "visits"), fresh: sum(23, "fresh"), ...time(23) },
    month: { views: sum(0, "views"), visits: sum(0, "visits"), fresh: sum(0, "fresh"), ...time(0) },
    now: rows.filter((r) => r.at && Date.parse(r.at) > fiveMin).length,
    series: series.slice(16), // the last 14 days, for the chart
    pages: top("pages"),
    sources: top("sources"),
    devices: top("devices"),
    recent: rows.slice(0, 20),
  };
}

// --- Gifts and limits

const cleanEmail = (e) => {
  const email = String(e ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Invalid email address.");
  return email;
};
const cleanLimit = (v) => {
  if (v === "" || v == null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1000) throw new Error("The limit must be between 0 and 1000 dollars.");
  return Math.round(n * 100) / 100;
};

/** Gifts a subscription to an email address for `months` months (0 = no end date). */
async function gift({ email, months, notify }) {
  email = cleanEmail(email);
  const n = Number(months);
  if (![0, 1, 3, 6, 12].includes(n)) throw new Error("Choose a duration.");
  const fields = { gift: { booleanValue: true }, invitedAt: { timestampValue: new Date().toISOString() } };
  // The sendGiftInvitation function emails them from BAPTOU's mailbox, then clears this flag.
  if (notify) fields.notify = { booleanValue: true };
  if (n > 0) {
    const end = new Date();
    end.setMonth(end.getMonth() + n);
    fields.expiresAt = { timestampValue: end.toISOString() };
  }
  // Replace the whole gift (a new duration replaces the old one, an end date can be removed).
  await fs(`access/${encodeURIComponent(email)}`, { method: "PATCH", body: JSON.stringify({ fields }) });
}

async function removeInvite({ email }) {
  await fs(`access/${encodeURIComponent(cleanEmail(email))}`, { method: "DELETE" });
}

/** Sets a monthly limit where it applies: the personal limit if the user has one, otherwise their invite. */
async function setLimit({ email, uid, limitUsd }) {
  email = cleanEmail(email);
  const limit = cleanLimit(limitUsd);
  if (limit == null) throw new Error("Enter a limit.");
  const priv = uid ? await fs(`private/${uid}`) : null;
  if (priv?.fields?.monthlyLimitUsd != null) {
    await fs(`private/${uid}?updateMask.fieldPaths=monthlyLimitUsd`, {
      method: "PATCH",
      body: JSON.stringify({ fields: { monthlyLimitUsd: { doubleValue: limit } } }),
    });
  } else {
    await fs(`access/${encodeURIComponent(email)}?updateMask.fieldPaths=monthlyLimitUsd&updateMask.fieldPaths=invitedAt`, {
      method: "PATCH",
      body: JSON.stringify({
        fields: { monthlyLimitUsd: { doubleValue: limit }, invitedAt: { timestampValue: new Date().toISOString() } },
      }),
    });
  }
  // Update the usage meter in the app right away (it is otherwise refreshed on the next AI call).
  if (uid) {
    await fs(`users/${uid}?updateMask.fieldPaths=usageSummary.limitUsd`, {
      method: "PATCH",
      body: JSON.stringify({ fields: { usageSummary: { mapValue: { fields: { limitUsd: { doubleValue: limit } } } } } }),
    }).catch(() => {});
  }
}

/**
 * Starts connecting BAPTOU's sender mailbox: saves a one-time state, then returns Google's consent page
 * (send permission only). Google comes back to the gmailOAuthCallback function, which stores the token.
 */
async function connectSender() {
  const env = readFileSync(join(here, "..", "functions", ".env"), "utf8");
  const clientId = env.match(/^GOOGLE_OAUTH_CLIENT_ID=(.+)$/m)?.[1].trim();
  if (!clientId) throw new Error("GOOGLE_OAUTH_CLIENT_ID is missing from functions/.env");
  const state = randomBytes(24).toString("hex");
  await fs("config/mailer?updateMask.fieldPaths=pending", {
    method: "PATCH",
    body: JSON.stringify({
      fields: {
        pending: {
          mapValue: {
            fields: { state: { stringValue: state }, email: { stringValue: SENDER }, createdAt: { integerValue: String(Date.now()) } },
          },
        },
      },
    }),
  });
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `https://${REGION}-${PROJECT}.cloudfunctions.net/gmailOAuthCallback`,
    response_type: "code",
    scope: "openid email https://www.googleapis.com/auth/gmail.send",
    access_type: "offline",
    prompt: "consent select_account",
    login_hint: SENDER,
    state: `sender.${state}`,
  });
  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` };
}

/** Why users turned suggestions down (users/{uid}/dismissedOffers), newest first. Read-only. */
async function feedback() {
  const docs = await query({ from: [{ collectionId: "dismissedOffers", allDescendants: true }] });
  const users = Object.fromEntries((await list("users")).map((u) => [id(u), str(u.fields?.email) ?? ""]));
  const rows = docs
    .map((doc) => {
      const f = doc.fields ?? {};
      const uid = doc.name.split("/users/")[1].split("/")[0];
      return {
        email: users[uid] ?? uid,
        at: f.dismissedAt?.timestampValue ?? null,
        kind: str(f.type) ?? "",
        search: str(f.searchName) ?? "",
        organization: str(f.organization) ?? "",
        title: str(f.title) ?? "",
        score: num(f.matchScore) ?? null,
        reason: str(f.reason) ?? "",
        url: str(f.url) ?? "",
        jobBoard: f.fromJobBoard?.booleanValue === true,
        manual: str(f.source) === "manual",
      };
    })
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  return { rows };
}

export default { overview, visits, gift, removeInvite, setLimit, connectSender, feedback };
