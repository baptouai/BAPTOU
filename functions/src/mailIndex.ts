import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getFunctions } from "firebase-admin/functions";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onTaskDispatched } from "firebase-functions/v2/tasks";
import { GMAIL_SECRETS, type Gmail, gmailFor, requireGmailRead } from "./gmail.js";
import { db, REGION } from "./shared.js";

// users/{uid}/mailIndex/{id}: one entry per person the user exchanged email with, built from message
// headers only (From/To/Cc/Date/Subject) through the Gmail API. No AI is involved, so it costs no credit.
// Offers are matched against it by organization tokens (see `orgTokens`), in the app, for free.

export type MailIndexEntry = {
  email: string;
  name: string;
  domain: string;
  tokens: string[]; // organization tokens from the address's domain, for matching offers
  sent: number; // emails the user sent them
  received: number; // emails they sent the user
  firstAt: number; // ms
  lastAt: number; // ms
  lastThreadId: string;
  lastSubject: string;
};

// --- Organization tokens (keep in sync with src/lib/orgTokens.ts in the app)

const GENERIC = new Set([
  // web and job-board parts of hostnames
  "www", "jobs", "job", "careers", "career", "apply", "recruiting", "recruitment", "talent", "boards", "mail", "email",
  "greenhouse", "lever", "workday", "myworkdayjobs", "smartrecruiters", "teamtailor", "welcometothejungle", "linkedin",
  "indeed", "glassdoor", "jobteaser", "workable", "recruitee", "bamboohr", "icims", "taleo", "successfactors",
  // top-level and common second-level domains
  "com", "org", "net", "edu", "gov", "int", "info", "biz", "fr", "co", "uk", "de", "es", "it", "nl", "be", "ch", "io",
  "eu", "us", "ca", "au", "jp", "cn", "in", "ie", "at", "se", "dk", "no", "fi", "pt", "pl", "lu", "ac",
  // personal email providers: say nothing about an organization
  "gmail", "googlemail", "outlook", "hotmail", "live", "yahoo", "icloud", "msn", "aol", "proton", "protonmail", "gmx",
  "orange", "free", "sfr", "laposte", "wanadoo", "bbox", "neuf", "numericable", "mac", "me", "ymail", "zoho",
]);
const STOP = new Set(["the", "and", "of", "for", "group", "groupe", "sa", "sas", "sarl", "ltd", "limited", "inc", "llc", "gmbh", "plc", "ag", "company", "co"]);

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function domainTokens(domain: string): string[] {
  return norm(domain)
    .split(".")
    .map((l) => l.replace(/[^a-z0-9]/g, ""))
    .filter((l) => l.length >= 3 && !GENERIC.has(l));
}

/** Tokens an email domain could carry for this organization (same as offerTokens in src/lib/orgTokens.ts). */
export function offerTokens(organization: string, applyUrl?: string): string[] {
  const words = norm(organization)
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w));
  const tokens = new Set<string>();
  for (const w of words) if (w.length >= 3 && !GENERIC.has(w)) tokens.add(w);
  for (let i = 0; i < words.length; i++) {
    for (let j = i + 2; j <= words.length; j++) tokens.add(words.slice(i, j).join(""));
  }
  if (applyUrl) {
    try {
      for (const label of new URL(applyUrl).hostname.split(".")) {
        const l = norm(label).replace(/[^a-z0-9]/g, "");
        if (l.length >= 3 && !GENERIC.has(l) && !/^wd\d+$/.test(l)) tokens.add(l);
      }
    } catch {
      // not a URL
    }
  }
  return [...tokens];
}

// --- Header parsing

const ADDRESS = /(?:"?([^"<>,]*?)"?\s*)?<([^<>\s]+@[^<>\s]+)>|([^\s,<>"]+@[^\s,<>"]+)/g;

function parseAddresses(header: string): { name: string; email: string }[] {
  const out: { name: string; email: string }[] = [];
  for (const m of header.matchAll(ADDRESS)) {
    const email = (m[2] ?? m[3] ?? "").trim().toLowerCase().replace(/^mailto:/, "");
    if (email.includes("@")) out.push({ name: (m[1] ?? "").trim(), email });
  }
  return out;
}

const AUTOMATED = /no-?reply|do-?not-?reply|notifications?@|newsletter|mailer|bounce|postmaster|daemon|alerts?@|news@|info@|marketing|updates?@|digest|support@|hello@|team@|contact@/;

type Header = { name: string; value: string };
type Msg = { id: string; threadId: string; internalDate?: string; payload?: { headers?: Header[] } };
const h = (m: Msg, name: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === name)?.value ?? "";

// --- Indexing

const BASE_QUERY = "-in:chats -category:promotions -category:social -category:forums -category:updates";
const MAX_THREADS_PER_RUN = 4000;
const RUN_SECONDS = 1500;
const CONCURRENCY = 10;

type IndexState = { newestAt?: number; oldestAt?: number; backfillDone?: boolean; people?: number };

async function listThreadIds(gmail: Gmail, query: string, max: number) {
  const ids: string[] = [];
  let pageToken = "";
  do {
    const page = (await gmail.call(
      `threads?q=${encodeURIComponent(query)}&maxResults=500${pageToken ? `&pageToken=${pageToken}` : ""}`,
    )) as { threads?: { id: string }[]; nextPageToken?: string };
    ids.push(...(page.threads ?? []).map((t) => t.id));
    pageToken = page.nextPageToken ?? "";
  } while (pageToken && ids.length < max);
  return ids.slice(0, max);
}

/** Updates the index with new mail, then continues the backfill of older mail. Free: no AI. */
export async function indexMailbox(uid: string) {
  const started = Date.now();
  const gmail = await gmailFor(uid);
  const own = gmail.email.toLowerCase();
  const userRef = db.doc(`users/${uid}`);
  const state = ((await userRef.get()).get("mailIndex") ?? {}) as IndexState;
  await userRef.set({ mailIndex: { status: "running" } }, { merge: true });

  // New mail first, then older mail the index hasn't reached yet.
  const toSec = (ms: number) => Math.floor(ms / 1000);
  const newer = state.newestAt ? await listThreadIds(gmail, `${BASE_QUERY} after:${toSec(state.newestAt)}`, MAX_THREADS_PER_RUN) : [];
  const older =
    state.backfillDone || newer.length >= MAX_THREADS_PER_RUN
      ? []
      : await listThreadIds(
          gmail,
          state.oldestAt ? `${BASE_QUERY} before:${toSec(state.oldestAt)}` : BASE_QUERY,
          MAX_THREADS_PER_RUN - newer.length,
        );
  const threadIds = [...new Set([...newer, ...older])];

  const people = new Map<string, MailIndexEntry>();
  let newestAt = state.newestAt ?? 0;
  let oldestAt = state.oldestAt ?? Number.MAX_SAFE_INTEGER;
  let processed = 0;

  const note = (addr: { name: string; email: string }, msg: Msg, at: number, direction: "sent" | "received") => {
    if (addr.email === own || AUTOMATED.test(addr.email)) return;
    const domain = addr.email.split("@")[1] ?? "";
    const p = people.get(addr.email) ?? {
      email: addr.email, name: "", domain, tokens: domainTokens(domain),
      sent: 0, received: 0, firstAt: at, lastAt: 0, lastThreadId: "", lastSubject: "",
    };
    p[direction]++;
    if (addr.name && !p.name) p.name = addr.name;
    p.firstAt = Math.min(p.firstAt, at);
    if (at > p.lastAt) {
      p.lastAt = at;
      p.lastThreadId = msg.threadId;
      p.lastSubject = h(msg, "subject").slice(0, 200);
    }
    people.set(addr.email, p);
  };

  for (let i = 0; i < threadIds.length; i += CONCURRENCY) {
    if ((Date.now() - started) / 1000 > RUN_SECONDS) break; // resume next run
    const batch = threadIds.slice(i, i + CONCURRENCY);
    const threads = await Promise.all(
      batch.map((id) =>
        gmail
          .call(
            `threads/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=List-Unsubscribe`,
          )
          .catch(() => null) as Promise<{ messages?: Msg[] } | null>,
      ),
    );
    for (const t of threads) {
      for (const m of t?.messages ?? []) {
        const at = Number(m.internalDate ?? 0);
        // A thread can span the already-indexed period (an old conversation with a new reply):
        // count only its messages outside [oldestAt, newestAt] so nothing is counted twice.
        if (state.newestAt && state.oldestAt && at >= state.oldestAt && at <= state.newestAt) continue;
        newestAt = Math.max(newestAt, at);
        oldestAt = Math.min(oldestAt, at);
        if (h(m, "list-unsubscribe")) continue; // bulk mail
        const from = parseAddresses(h(m, "from"))[0];
        if (from?.email === own) {
          for (const to of [...parseAddresses(h(m, "to")), ...parseAddresses(h(m, "cc"))]) note(to, m, at, "sent");
        } else if (from) {
          note(from, m, at, "received");
        }
      }
    }
    processed += batch.length;
  }

  // Merge into the stored index (counts add up, latest exchange wins).
  const entries = [...people.values()];
  for (let i = 0; i < entries.length; i += 200) {
    const chunk = entries.slice(i, i + 200);
    const refs = chunk.map((p) => db.doc(`users/${uid}/mailIndex/${createHash("sha1").update(p.email).digest("hex").slice(0, 20)}`));
    const existing = await db.getAll(...refs);
    const batch = db.batch();
    chunk.forEach((p, j) => {
      const old = existing[j].data() as MailIndexEntry | undefined;
      const latest = !old || p.lastAt >= old.lastAt;
      batch.set(refs[j], {
        email: p.email,
        name: p.name || old?.name || "",
        domain: p.domain,
        tokens: p.tokens,
        sent: (old?.sent ?? 0) + p.sent,
        received: (old?.received ?? 0) + p.received,
        firstAt: Math.min(old?.firstAt ?? p.firstAt, p.firstAt),
        lastAt: latest ? p.lastAt : old!.lastAt,
        lastThreadId: latest ? p.lastThreadId : old!.lastThreadId,
        lastSubject: latest ? p.lastSubject : old!.lastSubject,
      } satisfies MailIndexEntry);
    });
    await batch.commit();
  }

  const finishedBackfill = processed >= threadIds.length && older.length < MAX_THREADS_PER_RUN - newer.length;
  const count = (await db.collection(`users/${uid}/mailIndex`).count().get()).data().count;
  await userRef.set(
    {
      mailIndex: {
        status: "ready",
        updatedAt: FieldValue.serverTimestamp(),
        newestAt: newestAt || state.newestAt || null,
        oldestAt: oldestAt === Number.MAX_SAFE_INTEGER ? (state.oldestAt ?? null) : oldestAt,
        backfillDone: state.backfillDone || finishedBackfill,
        people: count,
      },
    },
    { merge: true },
  );
  logger.info("Mail index updated", { uid, threads: processed, people: count });
}

const queue = () => getFunctions().taskQueue(`locations/${REGION}/functions/indexMailboxTask`);
export const enqueueMailIndex = (uid: string) => queue().enqueue({ uid });

export const indexMailboxTask = onTaskDispatched<{ uid: string }>(
  { region: REGION, secrets: GMAIL_SECRETS, timeoutSeconds: 1800, memory: "1GiB", retryConfig: { maxAttempts: 1 }, rateLimits: { maxConcurrentDispatches: 3 } },
  async (req) => {
    try {
      await indexMailbox(req.data.uid);
    } catch (e) {
      logger.error("Mail index failed", { uid: req.data.uid, error: String(e) });
      await db.doc(`users/${req.data.uid}`).set({ mailIndex: { status: "error" } }, { merge: true });
    }
  },
);

/** "Update now" in the app. Free: header-only indexing, no AI. */
export const refreshMailIndex = onCall({ region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  const user = await db.doc(`users/${uid}`).get();
  if (!user.get("gmail.email")) throw new HttpsError("failed-precondition", "Connect your Gmail first (Profile page).");
  await requireGmailRead(uid);
  if (user.get("mailIndex.status") === "running" || user.get("mailIndex.status") === "queued") return { queued: false };
  await db.doc(`users/${uid}`).set({ mailIndex: { status: "queued" } }, { merge: true });
  await enqueueMailIndex(uid);
  return { queued: true };
});

/** Every morning, add the previous day's mail to every connected user's index. */
export const dailyMailIndex = onSchedule({ region: REGION, schedule: "every day 06:30", timeZone: "Europe/Paris" }, async () => {
  const connected = await db.collection("users").where("gmail.canRead", "==", true).select().get();
  for (const u of connected.docs) await enqueueMailIndex(u.id);
  logger.info(`Queued mail index for ${connected.size} users`);
});
