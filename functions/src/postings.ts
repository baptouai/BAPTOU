import { FieldValue } from "firebase-admin/firestore";
import { offerTokens } from "./mailIndex.js";
import { logger } from "firebase-functions/v2";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { db, REGION } from "./shared.js";

// Checks whether a posting's page still exists, with a plain HTTP request (no AI, no cost). Careers sites
// that block bots or render everything in JavaScript give "unknown", which is treated as open.

const JOB_PARAM = /[?&](jk|jid|jl|job_?id|gh_jid|req(uisition)?_?id|posting_?id|id)=/i;
const SEARCH_PARAM = /[?&](q|query|keywords?|search|kw|k|what)=/i;

/**
 * A link to a careers section or a list of offers rather than to one posting (e.g. /careers/graduate-opportunities,
 * a job board's search results). Keep in sync with src/lib/postingLink.ts in the app.
 */
export function looksGeneric(url: string) {
  try {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname).toLowerCase().replace(/\/+$/, "");
    const last = path.split("/").pop() ?? "";
    if (JOB_PARAM.test(u.search)) return false; // one posting, picked by its id
    // Search results and lists of offers (e.g. indeed.com/q-intern-l-miami-jobs.html, ziprecruiter.com/Jobs/
    // Intern/-in-Miami,FL, glassdoor …-SRCH_…), whatever numbers their links carry.
    if (/srch_|\/jobs?\/search|\/search-jobs/.test(path) || /(^|-)jobs(-|\.|$)/.test(last) || last.startsWith("-in-")) return true;
    if (SEARCH_PARAM.test(u.search)) return true;
    if (/\d{3,}|[a-f0-9]{10,}/.test(path + u.search)) return false; // posting ids
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

// Application systems that organizations run themselves: a posting there is the official one.
const ATS =
  /(^|\.)(myworkdayjobs|myworkdaysite|greenhouse|lever|smartrecruiters|successfactors|sapsf|taleo|icims|jobvite|ashbyhq|recruitee|teamtailor|workable|personio|bamboohr|oraclecloud|avature|eightfold|phenompeople|fluidjobs|breezy|applytojob|jazzhr|pinpointhq|rippling-ats|dayforcehcm|ultipro|paylocity|csod|brassring|softgarden|welcomekit|talentsoft|talent-soft|digitalrecruiters|flatchr|beetween|join)\.[a-z]{2,3}(\.[a-z]{2})?$/;

/**
 * Whether the link is the organization's own posting: on its own website (its name is in the domain) or
 * on an application system it runs. Anything else (job boards, aggregators, sites that copy postings)
 * is a third-party copy, even when it isn't in the BOARDS list.
 */
export function isOfficial(url: string, organization: string) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (BOARDS.test(host)) return false;
    if (ATS.test(host)) return true;
    const labels = host.split(".").map((l) => l.replace(/[^a-z0-9]/g, ""));
    return offerTokens(organization).some((t) => labels.some((l) => l === t || (t.length >= 5 && l.includes(t))));
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

/**
 * Checks that a posting is still open. With `organization`, a copy on a third-party site (job board,
 * aggregator) is followed to the organization's own posting when the page links to it: copies often stay
 * online after the real offer has closed.
 */
export async function checkPosting(url: string, organization?: string): Promise<PostingCheck> {
  const workday = await checkWorkday(url);
  if (workday) return workday;
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

    const html = await res.text();
    const text = pageText(html);
    const hit = CLOSED_TEXT.find((p) => p.test(text));
    if (hit) return { status: "closed", reason: "the page says the posting is no longer available" };

    if (organization && !isOfficial(url, organization)) {
      const official = officialLinks(html, res.url, organization).slice(0, 2);
      if (official.length) {
        const checks = await Promise.all(official.map((l) => checkPosting(l)));
        if (checks.some((c) => c.status === "open")) return { status: "open" };
        if (checks.every((c) => c.status === "closed")) {
          return { status: "closed", reason: "the offer on the organization's own site is closed" };
        }
      }
    }
    return { status: "open" };
  } catch {
    return { status: "unknown" };
  }
}

/**
 * Workday pages are an empty shell until JavaScript runs, so their text can't say whether a posting closed.
 * Workday's own job API can: a posting's details are there while it's open, and refused once it's gone.
 * Returns null for links that aren't Workday postings.
 */
async function checkWorkday(url: string): Promise<PostingCheck | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)myworkdayjobs\.com$/i.test(u.hostname)) return null;
  // /{optional locale}/{site}/job/{location}/{title}_{id}
  const m = /^\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?([^/]+)(\/job\/.+)$/.exec(u.pathname);
  if (!m) return null;
  const tenant = u.hostname.split(".")[0];
  try {
    const res = await fetch(`https://${u.hostname}/wday/cxs/${tenant}/${m[1]}${m[2]}`, {
      signal: AbortSignal.timeout(8000),
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 Chrome/130" },
    });
    if (res.ok) return { status: "open" };
    if ([403, 404, 410].includes(res.status)) return { status: "closed", reason: "the posting is no longer on the company's Workday site" };
    return { status: "unknown" };
  } catch {
    return { status: "unknown" };
  }
}

/** Links on a page (in its links or its scripts) to a specific posting on the organization's own site or application system. */
function officialLinks(html: string, base: string, organization: string) {
  const links = new Set<string>();
  const candidates = [
    ...[...html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)].map((m) => m[1]),
    ...[...html.matchAll(/https?:\/\/[^\s"'<>\\]+/gi)].map((m) => m[0]),
  ];
  for (const candidate of candidates) {
    try {
      const link = new URL(candidate.replace(/&amp;/g, "&"), base).href;
      const { pathname, search } = new URL(link);
      if (isOfficial(link, organization) && /\d{3,}|[a-f0-9]{8,}/i.test(pathname + search) && !looksGeneric(link)) links.add(link);
    } catch {
      // not a usable link
    }
  }
  return [...links];
}

/** Checks many links, a few at a time. */
export async function checkPostings(items: { url: string; organization?: string }[], concurrency = 5) {
  const results = new Map<string, PostingCheck>();
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const checks = await Promise.all(batch.map((it) => checkPosting(it.url, it.organization)));
    batch.forEach((it, j) => results.set(it.url, checks[j]));
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
      .select("applyUrl", "organization", "postingClosedAt")
      .get();
    const todo = live.docs.filter((d) => d.get("applyUrl") && !d.get("postingClosedAt"));
    const results = await checkPostings(
      todo.map((d) => ({ url: d.get("applyUrl") as string, organization: (d.get("organization") as string | undefined) ?? "" })),
    );
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
