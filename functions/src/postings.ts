import { FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import type { Browser } from "puppeteer-core";
import { offerTokens } from "./mailIndex.js";
import { dismissApplication } from "./offers.js";
import { db, REGION, requireAccess } from "./shared.js";

// Whether a posting is still open, checked without AI (no cost): the application system's own API when it has
// one, otherwise the page itself, read in a real browser when a plain request can't see it. An offer counts as
// open only when that is confirmed; a page that can't be read, or a job-board copy whose official posting can't
// be found, is "unknown" and is not suggested to the student.

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
  /(^|\.)(linkedin|indeed|glassdoor|monster|jobteaser|welcometothejungle|hellowork|labonnealternance|francetravail|pole-emploi|apec|cadremploi|meteojob|jobijoba|iquesta|letudiant|studentjob|stepstone|totaljobs|reed|cv-library|prospects|brightnetwork|gradcracker|ratemyplacement|targetjobs|milkround|simplyhired|ziprecruiter|adzuna|talent|jooble|careerjet|joinhandshake|wayup|internships|jobrapido|hosco|mastersportal|findamasters|studyportals|masterstudies|topuniversities|wizbii|fluidjobs|formulacareers|sportstechjobs|builtin|prosple|simplify|careercircle)\.[a-z]{2,3}(\.[a-z]{2})?$/;

// Application systems that organizations run themselves: a posting there is the official one.
const ATS =
  /(^|\.)(myworkdayjobs|myworkdaysite|greenhouse|lever|smartrecruiters|successfactors|sapsf|taleo|icims|jobvite|ashbyhq|recruitee|teamtailor|workable|personio|bamboohr|oraclecloud|avature|eightfold|phenompeople|breezy|applytojob|jazzhr|pinpointhq|rippling-ats|dayforcehcm|ultipro|paylocity|csod|brassring|softgarden|welcomekit|talentsoft|talent-soft|digitalrecruiters|flatchr|beetween|join)\.[a-z]{2,3}(\.[a-z]{2})?$/;

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
    // A sector word in the name ("Dassault Aviation") doesn't make a site its own (aviationjobs.fr is a job board).
    const all = offerTokens(organization);
    const distinctive = all.filter((t) => !SECTOR_WORDS.has(t));
    const tokens = distinctive.length ? distinctive : all; // "Naval Group": the sector word is the name
    return tokens.some((t) => labels.some((l) => l === t || (t.length >= 5 && l.includes(t))));
  } catch {
    return false;
  }
}

const SECTOR_WORDS = new Set([
  "aviation", "aircraft", "aerospace", "aeronautics", "aero", "space", "defence", "defense", "engineering", "engineers", "engine",
  "engines", "motor", "motors", "automotive", "auto", "cars", "racing", "energy", "energies", "systems", "system",
  "technologies", "technology", "tech", "solutions", "services", "consulting", "consultants", "industries", "industrial",
  "industry", "construction", "builders", "digital", "data", "bank", "banque", "capital", "finance", "financial",
  "insurance", "assurance", "global", "international", "network", "networks", "partners", "electric", "electronics",
  "power", "marine", "naval", "rail", "transport", "logistics", "health", "pharma", "research", "labs", "lab",
  "university", "school", "college", "institute", "design", "studio", "media", "software", "robotics", "mobility",
]);

export type PostingCheck = {
  status: "open" | "closed" | "unknown"; // unknown: couldn't be confirmed open
  reason?: string;
  officialUrl?: string; // for a job-board copy: the organization's own posting, confirmed open
};

const CLOSED_TEXT = [
  /no longer (available|accepting applications|open|active|online|accepting)/i,
  /(job|position|posting|vacancy|role|offer|opportunity|listing) (has )?(expired|been filled|been closed|is closed|is no longer)/i,
  /(job|position|posting|vacancy|role|listing) (has been|was) (removed|deleted|archived|closed|filled)/i,
  /(job|posting|page|offer) (not found|does not exist|doesn['’]t exist)/i,
  /we (couldn['’]t|could not|can['’]t|cannot) find (this|that|the) (job|position|posting|page)/i,
  /(can['’]t|cannot|couldn['’]t|could not) (seem to )?find the page/i,
  /page (introuvable|not found|n['’]existe pas)/i,
  /applications? (for this [a-z ]{1,25})?(are |is |have been |has been )?(now )?closed/i,
  /listing (has )?(expired|closed)/i,
  /expired (job|posting|listing|offer)/i,
  /n['’]est plus (disponible|en ligne|active|accessible|ouverte)/i,
  /(cette |l['’])offre (a expiré|est expirée|est clôturée|est pourvue|a été pourvue|n['’]existe plus)/i,
  /offre (expirée|pourvue|clôturée|n['’]existe plus|introuvable)/i,
  /cette annonce (a expiré|n['’]est plus)/i,
  /candidatures? (sont |est )?(closes?|clôturées?|terminées?)/i,
  /recrutement (est )?(terminé|clôturé)/i,
  /date limite (de candidature )?(est )?dépassée/i,
];

// A page that blocks automated visitors instead of showing the posting.
const BLOCKED_TEXT =
  /attention required|verify (that )?you are (a )?human|checking (if the site connection is secure|your browser)|access denied|enable javascript( and cookies)? to continue|are you a robot|pardon our interruption|just a moment|request blocked|captcha/i;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
// Same as in browser.ts: places a fetched page must never send the browser to.
const PRIVATE_HOST =
  /^(localhost|metadata|metadata\.google\.internal|.+\.internal)$|^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|^\[?(::1|f[cd][0-9a-f]{2}:)/i;
const DAY = 86_400_000;

const pageText = (html: string) =>
  html
    .slice(0, 400_000)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&#8217;|&rsquo;/g, "’")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const TITLE_STOP = new Set(["with", "pour", "dans", "avec", "from", "your", "votre", "this", "that", "level"]);

/** Whether the page names the posting: most of the title's significant words are on it. */
function mentionsTitle(text: string, title?: string) {
  const words = [...new Set(norm(title ?? "").split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !TITLE_STOP.has(w)))];
  if (!words.length) return true;
  const t = norm(text);
  return words.filter((w) => t.includes(w)).length / words.length >= 0.6;
}

/** The posting's structured data says it ended (schema.org JobPosting "validThrough" in the past). */
function expiredByData(html: string) {
  for (const m of html.matchAll(/"validThrough"\s*:\s*"([^"]+)"/g)) {
    const end = Date.parse(m[1]);
    if (!Number.isNaN(end) && end < Date.now() - DAY) return true;
  }
  return false;
}

const hasId = (p: string) => /\d{3,}|[a-f0-9]{8,}/i.test(p);

/** What a page shows: closed, open (it names the posting), or nothing conclusive. */
function readPage(text: string, html: string, title: string | undefined, official: boolean): PostingCheck {
  if (CLOSED_TEXT.some((p) => p.test(text))) return { status: "closed", reason: "the page says the posting is no longer available" };
  if (expiredByData(html)) return { status: "closed", reason: "the posting's end date has passed" };
  if (text.length < 2500 && BLOCKED_TEXT.test(text)) return { status: "unknown", reason: "the site blocks automated checks" };
  if (official && text.length >= 300 && mentionsTitle(text, title)) return { status: "open" };
  return { status: "unknown", reason: official ? "the page doesn't show the posting" : "job-board copy" };
}

// --- Application systems with a public API: an exact answer, no page to interpret.

async function getJson(url: string): Promise<{ status: number; body: unknown } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { Accept: "application/json", "User-Agent": UA } });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // no JSON body
    }
    return { status: res.status, body };
  } catch {
    return null;
  }
}

const GONE = [400, 403, 404, 410];

async function checkAts(u: URL): Promise<PostingCheck | null> {
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);

  // Workday pages are an empty shell until JavaScript runs; its job API answers while a posting is open.
  if (/(^|\.)myworkdayjobs\.com$/.test(host)) {
    const m = /^\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?([^/]+)(\/job\/.+)$/.exec(u.pathname); // /{locale?}/{site}/job/{location}/{title}_{id}
    if (!m) return null;
    const r = await getJson(`https://${u.hostname}/wday/cxs/${host.split(".")[0]}/${m[1]}${m[2]}`);
    if (!r) return null;
    if (r.status === 200) return { status: "open" };
    if (GONE.includes(r.status)) return { status: "closed", reason: "the posting is no longer on the company's Workday site" };
    return null;
  }

  // Greenhouse: boards.greenhouse.io/{board}/jobs/{id}, job-boards(.eu).greenhouse.io/{board}/jobs/{id}, or an embed with ?for=&token=.
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    let board = "";
    let id = "";
    const jobs = parts.indexOf("jobs");
    if (jobs > 0 && /^\d+$/.test(parts[jobs + 1] ?? "")) [board, id] = [parts[jobs - 1], parts[jobs + 1]];
    else if (u.searchParams.get("for") && /^\d+$/.test(u.searchParams.get("token") ?? "")) [board, id] = [u.searchParams.get("for")!, u.searchParams.get("token")!];
    if (!board) return null;
    const api = host.includes(".eu.") ? "boards-api.eu.greenhouse.io" : "boards-api.greenhouse.io";
    const r = await getJson(`https://${api}/v1/boards/${board}/jobs/${id}`);
    if (!r) return null;
    if (r.status === 200) return { status: "open" };
    if (r.status === 404) return { status: "closed", reason: "the posting is no longer on the company's Greenhouse board" };
    return null;
  }

  // Lever: jobs(.eu).lever.co/{company}/{uuid}
  if (/^jobs\.(eu\.)?lever\.co$/.test(host) && parts.length >= 2 && /^[0-9a-f-]{36}$/i.test(parts[1])) {
    const api = host.includes(".eu.") ? "api.eu.lever.co" : "api.lever.co";
    const r = await getJson(`https://${api}/v0/postings/${parts[0]}/${parts[1]}`);
    if (!r) return null;
    if (r.status === 200) return { status: "open" };
    if (r.status === 404) return { status: "closed", reason: "the posting is no longer on the company's Lever page" };
    return null;
  }

  // SmartRecruiters: jobs|careers.smartrecruiters.com/{company}/{id}-{slug}
  if (/^(jobs|careers)\.smartrecruiters\.com$/.test(host) && parts.length >= 2) {
    const id = /^(\d{6,})/.exec(parts[1])?.[1];
    if (!id) return null;
    const r = await getJson(`https://api.smartrecruiters.com/v1/companies/${parts[0]}/postings/${id}`);
    if (!r) return null;
    if (r.status === 200) {
      return (r.body as { active?: boolean } | null)?.active === false
        ? { status: "closed", reason: "the posting is no longer active on SmartRecruiters" }
        : { status: "open" };
    }
    if (GONE.includes(r.status)) return { status: "closed", reason: "the posting is no longer on SmartRecruiters" };
    return null;
  }

  // Ashby: jobs.ashbyhq.com/{org}/{uuid}: the organization's board lists every open posting.
  if (host === "jobs.ashbyhq.com" && parts.length >= 2 && /^[0-9a-f-]{36}$/i.test(parts[1])) {
    const r = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${parts[0]}`);
    const list = (r?.body as { jobs?: { id: string }[] } | null)?.jobs;
    if (r?.status !== 200 || !Array.isArray(list)) return null;
    return list.some((j) => j.id === parts[1])
      ? { status: "open" }
      : { status: "closed", reason: "the posting is no longer on the company's Ashby board" };
  }

  // Workable: apply.workable.com/{account}/j/{shortcode}
  if (host === "apply.workable.com" && parts.length >= 3 && parts[1] === "j") {
    const r = await getJson(`https://apply.workable.com/api/v2/accounts/${parts[0]}/jobs/${parts[2]}`);
    if (!r) return null;
    if (r.status === 200) return { status: "open" };
    if (r.status === 404) return { status: "closed", reason: "the posting is no longer on Workable" };
    return null;
  }
  return null;
}

// --- Reading pages

type Fetched = { status: number; url: string; html: string; text: string };

async function fetchPage(url: string): Promise<Fetched | null> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": UA, "Accept-Language": "en,fr;q=0.8", Accept: "text/html,application/xhtml+xml" },
    });
    const html = res.ok ? (await res.text()).slice(0, 600_000) : "";
    return { status: res.status, url: res.url || url, html, text: pageText(html) };
  } catch {
    return null;
  }
}

/** A headless Chrome, opened on first use and shared by the checks of one run. Close it when done. */
export class PageReader {
  private browser: Promise<Browser | null> | null = null;

  private launch() {
    this.browser ??= (async () => {
      try {
        const { default: puppeteer } = await import("puppeteer-core");
        let executablePath = process.env.CHROME_PATH; // local tests
        let args: string[] = [];
        if (!executablePath) {
          const { default: chromium } = await import("@sparticuz/chromium");
          executablePath = await chromium.executablePath();
          args = chromium.args;
        }
        return await puppeteer.launch({ executablePath, args, headless: true, defaultViewport: { width: 1280, height: 900 } });
      } catch (e) {
        logger.warn("Headless Chrome unavailable for posting checks", e);
        return null;
      }
    })();
    return this.browser;
  }

  async read(url: string): Promise<Fetched | null> {
    const browser = await this.launch();
    if (!browser) return null;
    const page = await browser.newPage().catch(() => null);
    if (!page) return null;
    try {
      await page.setUserAgent(UA);
      await page.setExtraHTTPHeaders({ "Accept-Language": "en,fr;q=0.8" });
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        let host = "";
        let protocol = "";
        try {
          ({ hostname: host, protocol } = new URL(req.url()));
        } catch {
          return void req.abort();
        }
        if (!["https:", "http:", "data:", "blob:"].includes(protocol) || PRIVATE_HOST.test(host)) return void req.abort();
        if (["image", "media", "font"].includes(req.resourceType())) return void req.abort();
        return void req.continue();
      });
      const res = await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 }).catch(() => null);
      await new Promise((r) => setTimeout(r, 1200)); // late scripts that swap in a "closed" message
      const seen = await page.evaluate(() => ({
        url: location.href,
        text: document.body?.innerText ?? "",
        html: document.documentElement.outerHTML.slice(0, 600_000),
      }));
      return { status: res?.status() ?? 0, url: seen.url, html: seen.html, text: seen.text.replace(/\s+/g, " ") };
    } catch {
      return null;
    } finally {
      await page.close().catch(() => {});
    }
  }

  async close() {
    const browser = await this.browser;
    this.browser = null;
    await browser?.close().catch(() => {});
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
      if (isOfficial(link, organization) && hasId(pathname + search) && !looksGeneric(link)) links.add(link);
    } catch {
      // not a usable link
    }
  }
  return [...links];
}

type CheckOptions = { organization?: string; title?: string; reader?: PageReader | null; depth?: number };

/**
 * Checks that a posting is still open. A copy on a third-party site (job board, aggregator) counts only through
 * the organization's own posting, when the copy links to it: copies often stay online after the real offer has
 * closed, and some can't be checked at all.
 */
export async function checkPosting(url: string, opts: CheckOptions = {}): Promise<PostingCheck> {
  const { organization = "", title, reader, depth = 0 } = opts;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { status: "unknown", reason: "not a valid link" };
  }
  if (looksGeneric(url)) return { status: "unknown", reason: "the link leads to a list of offers, not to one posting" };
  const ats = await checkAts(u);
  if (ats) return ats;

  const official = !organization || isOfficial(url, organization);
  const throughOfficial = async (page: Fetched): Promise<PostingCheck | null> => {
    if (official || depth > 0) return null;
    const links = officialLinks(page.html, page.url, organization).slice(0, 3);
    if (!links.length) return null;
    const checks = await Promise.all(links.map((l) => checkPosting(l, { ...opts, depth: depth + 1 })));
    const open = checks.findIndex((c) => c.status === "open");
    if (open >= 0) return { status: "open", officialUrl: links[open] };
    if (checks.every((c) => c.status === "closed")) return { status: "closed", reason: "the offer on the organization's own site is closed" };
    return null;
  };
  const verdict = async (page: Fetched): Promise<PostingCheck> => {
    if (page.status === 404 || page.status === 410) return { status: "closed", reason: `the page no longer exists (${page.status})` };
    // A link to one posting (with an id) that now lands on a general careers page.
    const to = (() => {
      try {
        return new URL(page.url);
      } catch {
        return u;
      }
    })();
    if (hasId(u.pathname + u.search) && !hasId(to.pathname + to.search) && to.href !== u.href) {
      return { status: "closed", reason: "the link now redirects to a general careers page" };
    }
    if (to.href !== u.href && /(^|[/_.-])(404|not-?found|page-?not-?found|error)([/_.-]|$)/i.test(to.pathname)) {
      return { status: "closed", reason: "the link now leads to an error page" };
    }
    const seen = readPage(page.text, page.html, title, official);
    if (seen.status === "closed") return seen;
    return (await throughOfficial(page)) ?? seen;
  };

  // 1. A plain request: enough for most pages.
  const plain = await fetchPage(url);
  if (plain && (plain.status === 404 || plain.status === 410 || plain.html)) {
    const v = await verdict(plain);
    if (v.status !== "unknown") return v;
  }
  // 2. The page in a real browser: pages built by JavaScript, or that refuse plain requests.
  if (reader) {
    const seen = await reader.read(url);
    if (seen && (seen.status === 404 || seen.status === 410 || seen.text)) {
      const v = await verdict(seen);
      if (v.status !== "unknown" || official) return v;
      return { status: "unknown", reason: "job-board copy: the organization's own posting couldn't be found from it" };
    }
  }
  if (!official) return { status: "unknown", reason: "job-board copy: the organization's own posting couldn't be found from it" };
  return { status: "unknown", reason: plain && !plain.html ? `the site refused the check (${plain.status})` : "the page couldn't be read" };
}

/** Checks many links, a few at a time. */
export async function checkPostings(
  items: { url: string; organization?: string; title?: string }[],
  reader?: PageReader | null,
  concurrency = 4,
) {
  const results = new Map<string, PostingCheck>();
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const checks = await Promise.all(
      batch.map((it) => checkPosting(it.url, { organization: it.organization, title: it.title, reader }).catch((): PostingCheck => ({ status: "unknown" }))),
    );
    batch.forEach((it, j) => results.set(it.url, checks[j]));
  }
  return results;
}

/**
 * Applies a check to an offer in the student's lists. A suggested offer whose posting closed is removed (and
 * remembered, so it never comes back); one that can't be confirmed open twice in a row is removed too. An offer
 * the student is working on is kept and flagged instead.
 */
export async function applyCheck(
  ref: FirebaseFirestore.DocumentReference,
  app: FirebaseFirestore.DocumentData,
  check: PostingCheck,
  { mayRemove = true } = {},
) {
  const uid = ref.parent.parent!.id;
  const suggested = mayRemove && app.status === "suggested" && app.source !== "manual";
  if (check.status === "closed") {
    if (suggested) return dismissApplication(uid, ref, app, `Posting closed (checked by BAPTOU): ${check.reason ?? ""}`.trim());
    return ref.update({ postingClosedAt: FieldValue.serverTimestamp(), postingClosedReason: check.reason ?? "", postingCheckedAt: FieldValue.serverTimestamp() });
  }
  if (check.status === "unknown") {
    const misses = ((app.postingUnverified as number | undefined) ?? 0) + 1;
    // A job-board copy with no official posting, or a list of offers, won't become checkable tomorrow; a site
    // that refused the check might.
    const lasting = /job-board copy|list of offers|not a valid link/.test(check.reason ?? "");
    if (suggested && (lasting || misses >= 2)) {
      return dismissApplication(uid, ref, app, `Couldn't be confirmed open (checked by BAPTOU): ${check.reason ?? ""}`.trim());
    }
    return ref.update({ postingUnverified: misses, postingCheckedAt: FieldValue.serverTimestamp() });
  }
  return ref.update({ postingCheckedAt: FieldValue.serverTimestamp(), postingUnverified: FieldValue.delete() });
}

/**
 * Every morning, before the searches, recheck the offers still in play (not applied to yet), the least recently
 * checked first.
 */
export const recheckPostings = onSchedule(
  { region: REGION, schedule: "every day 05:15", timeZone: "Europe/Paris", timeoutSeconds: 1800, memory: "2GiB" },
  async () => {
    const live = await db
      .collectionGroup("applications")
      .where("status", "in", ["suggested", "interested", "editing"])
      .get();
    // Suggested offers flagged closed earlier (before closed suggestions were removed) leave the lists too.
    for (const d of live.docs.filter((x) => x.get("status") === "suggested" && x.get("postingClosedAt") && x.get("source") !== "manual")) {
      await dismissApplication(d.ref.parent.parent!.id, d.ref, d.data(), `Posting closed (checked by BAPTOU): ${d.get("postingClosedReason") ?? ""}`.trim()).catch(
        (e) => logger.warn(`Couldn't remove closed offer ${d.ref.path}`, e),
      );
    }
    const todo = live.docs
      .filter((d) => d.get("applyUrl") && !d.get("postingClosedAt") && d.get("type") !== "masters")
      .sort((a, b) => (a.get("postingCheckedAt")?.toMillis?.() ?? 0) - (b.get("postingCheckedAt")?.toMillis?.() ?? 0))
      .slice(0, 300);
    const reader = new PageReader();
    const tally = { open: 0, closed: 0, unknown: 0 };
    try {
      for (let i = 0; i < todo.length; i += 4) {
        const batch = todo.slice(i, i + 4);
        await Promise.all(
          batch.map(async (d) => {
            const app = d.data();
            const check = await checkPosting(app.applyUrl, { organization: app.organization ?? "", title: app.title, reader }).catch(
              (): PostingCheck => ({ status: "unknown" }),
            );
            tally[check.status]++;
            await applyCheck(d.ref, app, check).catch((e) => logger.warn(`Recheck update failed for ${d.ref.path}`, e));
          }),
        );
      }
    } finally {
      await reader.close();
    }
    logger.info(`Rechecked ${todo.length} postings: ${tally.open} open, ${tally.closed} closed, ${tally.unknown} unconfirmed`);
  },
);

/** When the student opens an offer: a fresh check if the last one is more than a few hours old. */
export const checkPostingNow = onCall({ region: REGION, memory: "2GiB", timeoutSeconds: 120 }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  await requireAccess(uid);
  const applicationId = String(request.data?.applicationId ?? "");
  if (!applicationId) throw new HttpsError("invalid-argument", "Missing applicationId.");
  const ref = db.doc(`users/${uid}/applications/${applicationId}`);
  const app = (await ref.get()).data();
  if (!app?.applyUrl || !["suggested", "interested", "editing"].includes(app.status) || app.type === "masters") return { status: "skipped" };
  if (app.postingClosedAt) return { status: "closed", reason: app.postingClosedReason ?? "" };
  const checkedAt = app.postingCheckedAt?.toMillis?.() ?? 0;
  if (Date.now() - checkedAt < 6 * 3600_000) return { status: app.postingUnverified ? "unknown" : "open" };

  const reader = new PageReader();
  try {
    const check = await checkPosting(app.applyUrl, { organization: app.organization ?? "", title: app.title, reader });
    // The student is looking at it: flagged, never removed from under them.
    await applyCheck(ref, app, check, { mayRemove: false });
    return { status: check.status, reason: check.reason ?? "" };
  } finally {
    await reader.close();
  }
});
