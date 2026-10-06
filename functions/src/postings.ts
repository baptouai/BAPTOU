import { FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { db, REGION } from "./shared.js";

// Checks whether a posting's page still exists, with a plain HTTP request (no AI, no cost). Careers sites
// that block bots or render everything in JavaScript give "unknown", which is treated as open.

/**
 * A link to a careers section rather than to one posting (e.g. /careers/graduate-opportunities).
 * Keep in sync with src/lib/postingLink.ts in the app.
 */
export function looksGeneric(url: string) {
  try {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname).toLowerCase().replace(/\/+$/, "");
    if (/\d{3,}|[a-f0-9]{10,}/.test(path + u.search)) return false; // posting ids
    const last = path.split("/").pop() ?? "";
    if (!last) return true;
    return /^(careers?|jobs?|vacanc(y|ies)|opportunit(y|ies)|graduates?|graduate-(opportunities|programmes?|programs?|jobs)|early-careers?|internships?|students?|placements?|join-us|work-with-us|join|recrutement|emplois?|offres?(-d-emploi)?|stages?|alternances?|nous-rejoindre|search|search-results|en|fr|int-en)$/.test(last);
  } catch {
    return false;
  }
}

// Job boards and aggregators: good for finding offers, but the organization's own posting is preferred
// (it is the one that stays up to date and leads to the real application form). Matched on the site's
// own domain only, so e.g. talent.lvmh.com is not mistaken for talent.com.
const BOARDS =
  /(^|\.)(linkedin|indeed|glassdoor|monster|jobteaser|welcometothejungle|hellowork|labonnealternance|francetravail|pole-emploi|apec|cadremploi|meteojob|jobijoba|iquesta|letudiant|studentjob|stepstone|totaljobs|reed|cv-library|prospects|brightnetwork|gradcracker|ratemyplacement|targetjobs|milkround|simplyhired|ziprecruiter|adzuna|talent|jooble|careerjet|joinhandshake|wayup|internships|jobrapido|hosco|mastersportal|findamasters|studyportals|masterstudies|topuniversities)\.[a-z]{2,3}(\.[a-z]{2})?$/;

export function isJobBoard(url: string) {
  try {
    return BOARDS.test(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export type PostingCheck = { status: "open" | "closed" | "unknown"; reason?: string };

const CLOSED_TEXT = [
  /no longer (available|accepting applications|open|active|online)/i,
  /(job|position|posting|vacancy|role|offer|opportunity) (has )?(expired|been filled|been closed|is closed|is no longer)/i,
  /(job|posting|page) (not found|does not exist|doesn't exist)/i,
  /applications? (are |is )?(now )?closed/i,
  /n['’]est plus (disponible|en ligne|active|accessible)/i,
  /(cette |l['’])offre (a expiré|est expirée|est clôturée|est pourvue|a été pourvue)/i,
  /(position|role|vacancy) (has been|was) filled/i,
  /offre (expirée|pourvue|clôturée|n['’]existe plus)/i,
  /cette annonce (a expiré|n['’]est plus)/i,
];

const pageText = (html: string) =>
  html
    .slice(0, 400_000)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

export async function checkPosting(url: string): Promise<PostingCheck> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36",
        "Accept-Language": "en,fr;q=0.8",
      },
    });
    if (res.status === 404 || res.status === 410) return { status: "closed", reason: `the page no longer exists (${res.status})` };
    if (!res.ok) return { status: "unknown" };

    // A link to a specific posting (with an id in it) that now lands on a general careers page.
    const from = new URL(url);
    const to = new URL(res.url);
    const hasId = (p: string) => /\d{3,}|[a-f0-9]{8,}/i.test(p);
    if (hasId(from.pathname + from.search) && !hasId(to.pathname + to.search) && to.href !== from.href) {
      return { status: "closed", reason: "the link now redirects to a general careers page" };
    }

    const text = pageText(await res.text());
    const hit = CLOSED_TEXT.find((p) => p.test(text));
    if (hit) return { status: "closed", reason: "the page says the posting is no longer available" };
    return { status: "open" };
  } catch {
    return { status: "unknown" };
  }
}

/** Checks many links, a few at a time. */
export async function checkPostings(urls: string[], concurrency = 5) {
  const results = new Map<string, PostingCheck>();
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const checks = await Promise.all(batch.map(checkPosting));
    batch.forEach((u, j) => results.set(u, checks[j]));
  }
  return results;
}

/**
 * Every morning, recheck the offers still in play (not applied to yet) and flag those whose posting is
 * gone, so the student doesn't prepare an application for nothing.
 */
export const recheckPostings = onSchedule(
  { region: REGION, schedule: "every day 06:00", timeZone: "Europe/Paris", timeoutSeconds: 540 },
  async () => {
    const live = await db
      .collectionGroup("applications")
      .where("status", "in", ["suggested", "interested", "editing"])
      .select("applyUrl", "postingClosedAt")
      .get();
    const todo = live.docs.filter((d) => d.get("applyUrl") && !d.get("postingClosedAt"));
    const results = await checkPostings(todo.map((d) => d.get("applyUrl") as string));
    let closed = 0;
    for (const d of todo) {
      const r = results.get(d.get("applyUrl"));
      if (r?.status === "closed") {
        closed++;
        await d.ref.update({ postingClosedAt: FieldValue.serverTimestamp(), postingClosedReason: r.reason ?? "" });
      }
    }
    logger.info(`Rechecked ${todo.length} postings, ${closed} closed`);
  },
);
