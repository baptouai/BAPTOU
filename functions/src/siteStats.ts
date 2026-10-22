import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { onRequest } from "firebase-functions/v2/https";
import { db, REGION } from "./shared.js";

// Visits to baptou.com, counted without cookies and without IP addresses. The site's script (theme.js)
// posts the page and the address the visitor came from to /api/hit (a Hosting rewrite to this function).
// Kept: daily counters in siteStats/{YYYY-MM-DD} (views, visits, newVisitors, pages, sources, devices) and
// each page view in siteVisits, deleted after 30 days by a TTL policy on expireAt. Read only by BAPTOU Admin; the
// database rules give no client access to either collection.
const BOT = /bot|crawl|spider|slurp|headless|preview|facebookexternalhit|lighthouse|monitor|curl|wget|python/i;

// The endpoint is public, so what it records is bounded: only the site's own pages are kept by name (anything
// else counts as "/other"), source names must look like host names, one client can't send more than a few hits
// a minute, and each instance records at most a few hundred a minute in all (so even forged headers can't run
// up the database bill). Counted in memory only, by a hash of the forwarding chain that is never stored.
const PAGE = /^\/(fr|essai|legal|privacy|terms|guides(\/[a-z0-9-]{1,80})?)?$/;
const HOST = /^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63}){1,5}$/;
const PER_CLIENT = 20;
const PER_INSTANCE = 300;
const recent = new Map<string, { n: number; since: number }>();
let total = { n: 0, since: 0 };

function tooMany(client: string) {
  const now = Date.now();
  if (now - total.since > 60_000) total = { n: 0, since: now };
  if (++total.n > PER_INSTANCE) return true;
  if (recent.size > 5000) for (const [k, v] of recent) if (now - v.since > 60_000) recent.delete(k);
  const key = createHash("sha256").update(client).digest("base64").slice(0, 16);
  const entry = recent.get(key);
  if (!entry || now - entry.since > 60_000) {
    recent.set(key, { n: 1, since: now });
    return false;
  }
  return ++entry.n > PER_CLIENT;
}

/**
 * Time on the site (theme.js, since 20 Oct 2026): the seconds a page stayed on screen, sent each time it is hidden;
 * v = 1 when the visit started as a new person. Only the day's totals grow: `seconds` for every visit and
 * `newSeconds` for new people (BAPTOU Admin divides them by timedVisits and timedNewVisitors). No page view, no
 * siteVisits row.
 */
async function recordTime(body: { t?: unknown; v?: unknown }, ua: string) {
  const secs = Math.min(Math.round(Number(body.t)), 1800);
  if (!Number.isFinite(secs) || secs < 1 || !ua || BOT.test(ua)) return;
  const time: Record<string, unknown> = { seconds: FieldValue.increment(secs) };
  if (Number(body.v) === 1) time.newSeconds = FieldValue.increment(secs);
  await db.doc(`siteStats/${new Date().toISOString().slice(0, 10)}`).set(time, { merge: true });
}

export const siteHit = onRequest(
  { region: REGION, invoker: "public", maxInstances: 5, memory: "256MiB", concurrency: 40 },
  async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (req.method !== "POST") {
      res.status(405).end();
      return;
    }
    // Behind the Hosting rewrite, the forwarding chain identifies the visitor well enough for a rate limit.
    if (tooMany(`${req.get("x-forwarded-for") ?? ""}|${req.ip ?? ""}`)) {
      res.status(204).end();
      return;
    }
    // Sent as text/plain (no CORS preflight): the body may arrive as a string, a buffer or parsed JSON.
    let body: { p?: unknown; r?: unknown; n?: unknown; w?: unknown; t?: unknown; v?: unknown } = {};
    try {
      body = typeof req.body === "object" && !Buffer.isBuffer(req.body) ? req.body : JSON.parse(String(req.body ?? "{}"));
    } catch {
      body = {};
    }
    if (body.t !== undefined) {
      await recordTime(body, String(req.get("user-agent") ?? ""));
      res.status(204).end();
      return;
    }
    const raw = String(body.p ?? "/").slice(0, 120).toLowerCase().replace(/\.html$/, "").replace(/\/index$/, "/");
    const trimmed = raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
    const path = PAGE.test(trimmed) ? trimmed : "/other";
    let from = "";
    try {
      from = body.r ? new URL(String(body.r)).hostname.toLowerCase().replace(/^www\./, "") : "";
    } catch {
      from = "";
    }
    if (from && !HOST.test(from)) from = "other";
    const ua = String(req.get("user-agent") ?? "");
    const inc = FieldValue.increment(1);
    const day = new Date().toISOString().slice(0, 10);
    if (!ua || BOT.test(ua)) {
      await db.doc(`siteStats/${day}`).set({ bots: inc }, { merge: true });
      res.status(204).end();
      return;
    }
    // A visit starts when someone arrives from outside the site (another website, an app, or typed in).
    const visit = !/(^|\.)baptou\.com$/.test(from);
    // A new person: this browser's first visit (theme.js keeps a "seen" date, no identifier). Only visits from
    // outside count, so users coming over from the app (app.baptou.com) aren't counted as new.
    const fresh = visit && Number(body.n) === 1;
    const source = from || "direct";
    const device = /mobile|android|iphone|ipad/i.test(ua) ? "mobile" : "desktop";
    // Nested maps with merge: page paths and host names are used as keys as they are (no dot parsing).
    const counters: Record<string, unknown> = { views: inc, pages: { [path]: inc } };
    if (visit) Object.assign(counters, { visits: inc, sources: { [source]: inc }, devices: { [device]: inc } });
    if (fresh) counters.newVisitors = inc;
    // The same counts, only for visits whose pages report their time on screen (theme.js sends w = 1): what the
    // time totals are divided by, so visits from before 20 Oct 2026 or from a cached older script don't count.
    if (Number(body.w) === 1) {
      if (visit) counters.timedVisits = inc;
      if (fresh) counters.timedNewVisitors = inc;
    }
    await Promise.all([
      db.doc(`siteStats/${day}`).set(counters, { merge: true }),
      db.collection("siteVisits").add({
        at: FieldValue.serverTimestamp(),
        path,
        from: visit ? source : null,
        device,
        new: fresh,
        expireAt: new Date(Date.now() + 30 * 86_400_000),
      }),
    ]);
    res.status(204).end();
  },
);
