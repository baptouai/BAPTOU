import { FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { db, type Kind } from "./shared.js";

// Organizations' own application systems, read through their public APIs (no AI, no cost): every posting an
// organization has open, not just the few a web search happens to show. Searches use these postings first and
// web search only for what they can't cover (organizations with their own careers sites).

export type BoardKind = "workday" | "greenhouse" | "lever" | "smartrecruiters" | "ashby";
export type Board = { company: string; kind: BoardKind; id: string }; // Workday id: "tenant.wdN/site"
export type BoardPosting = { company: string; title: string; place: string; url: string; details: string };

const UA = { "User-Agent": "Mozilla/5.0 (compatible; BAPTOU/1.0; +https://baptou.com)", Accept: "application/json" };

async function getJson<T = unknown>(url: string, init: RequestInit = {}): Promise<T | null> {
  try {
    const res = await fetch(url, { ...init, headers: { ...UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(15000) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

const strip = (html: unknown) =>
  String(html ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#xa0;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

// --- Finding an organization's board

/** How many postings a board has open (0 if it doesn't exist). */
export async function probeBoard(kind: BoardKind, id: string): Promise<number> {
  if (kind === "smartrecruiters") {
    const j = await getJson<{ totalFound?: number }>(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(id)}/postings?limit=1`);
    return j?.totalFound ?? 0;
  }
  if (kind === "greenhouse") {
    const j = await getJson<{ jobs?: unknown[] }>(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(id)}/jobs`);
    return j?.jobs?.length ?? 0;
  }
  if (kind === "lever") {
    for (const api of ["api.lever.co", "api.eu.lever.co"]) {
      const j = await getJson<unknown[]>(`https://${api}/v0/postings/${encodeURIComponent(id)}?mode=json&limit=1`);
      if (Array.isArray(j) && j.length) return j.length;
    }
    return 0;
  }
  if (kind === "ashby") {
    const j = await getJson<{ jobs?: unknown[] }>(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(id)}`);
    return j?.jobs?.length ?? 0;
  }
  const wd = workday(id);
  if (!wd) return 0;
  const j = await getJson<{ total?: number }>(`${wd.api}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: "" }),
  });
  return j?.total ?? 0;
}

function workday(id: string) {
  const m = /^([a-z0-9-]+)\.(wd\d+)\/([A-Za-z0-9_-]+)$/i.exec(id);
  if (!m) return null;
  const [, tenant, wd, site] = m;
  return { host: `https://${tenant}.${wd}.myworkdayjobs.com`, site, api: `https://${tenant}.${wd}.myworkdayjobs.com/wday/cxs/${tenant}/${site}` };
}

/** Boards that links in a page (or a single link) point to. */
export function boardsInText(text: string): { kind: BoardKind; id: string }[] {
  const found = new Map<string, { kind: BoardKind; id: string }>();
  const add = (kind: BoardKind, id: string) => id && found.set(`${kind}:${id.toLowerCase()}`, { kind, id });
  for (const m of text.matchAll(/https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)/g)) {
    if (!/^(wday|job|jobs)$/i.test(m[3])) add("workday", `${m[1]}.${m[2]}/${m[3]}`);
  }
  for (const m of text.matchAll(/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/gi)) {
    if (!/^(embed|v1)$/i.test(m[1])) add("greenhouse", m[1]);
  }
  for (const m of text.matchAll(/boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9_-]+)/gi)) add("greenhouse", m[1]);
  for (const m of text.matchAll(/jobs\.(?:eu\.)?lever\.co\/([a-z0-9_.-]+)/gi)) add("lever", m[1]);
  for (const m of text.matchAll(/(?:jobs|careers)\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/g)) add("smartrecruiters", m[1]);
  for (const m of text.matchAll(/jobs\.ashbyhq\.com\/([A-Za-z0-9_.-]+)/g)) add("ashby", m[1]);
  return [...found.values()];
}

export type OrganizationLead = { name: string; careersUrl?: string; ats?: string; atsId?: string };

const slug = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120) || "unknown";

/**
 * Each organization's board, if it has one BAPTOU can read: remembered in a registry shared by all searches
 * (boards/{slug}), otherwise found from the AI's guess or the links on its careers page, and checked.
 */
export async function resolveBoards(orgs: OrganizationLead[]): Promise<Board[]> {
  const MONTH = 30 * 86_400_000;
  const results = await pool(orgs, 6, async (org): Promise<Board | null> => {
    const ref = db.doc(`boards/${slug(org.name)}`);
    const known = (await ref.get()).data();
    if (known && Date.now() - (known.checkedAt?.toMillis?.() ?? 0) < MONTH) {
      return known.kind ? { company: known.company ?? org.name, kind: known.kind, id: known.id } : null;
    }
    const guesses: { kind: BoardKind; id: string }[] = [];
    const kind = (org.ats ?? "").toLowerCase() as BoardKind;
    if (["workday", "greenhouse", "lever", "smartrecruiters", "ashby"].includes(kind) && org.atsId) guesses.push({ kind, id: org.atsId.trim() });
    if (org.careersUrl) guesses.push(...boardsInText(org.careersUrl));
    let board: Board | null = null;
    for (const g of guesses) {
      if ((await probeBoard(g.kind, g.id)) > 0) {
        board = { company: org.name, ...g };
        break;
      }
    }
    // The careers page often links to (or embeds) the application system.
    if (!board && org.careersUrl && /^https?:\/\//i.test(org.careersUrl)) {
      try {
        const res = await fetch(org.careersUrl, { redirect: "follow", headers: { "User-Agent": UA["User-Agent"] }, signal: AbortSignal.timeout(12000) });
        const html = res.ok ? (await res.text()).slice(0, 800_000) : "";
        for (const g of [...boardsInText(res.url), ...boardsInText(html)].slice(0, 6)) {
          if ((await probeBoard(g.kind, g.id)) > 0) {
            board = { company: org.name, ...g };
            break;
          }
        }
      } catch {
        // careers page unreachable
      }
    }
    await ref.set(
      board
        ? { company: org.name, kind: board.kind, id: board.id, checkedAt: FieldValue.serverTimestamp() }
        : { company: org.name, careersUrl: org.careersUrl ?? "", kind: null, checkedAt: FieldValue.serverTimestamp() },
    );
    return board;
  });
  const boards = results.filter((b): b is Board => !!b);
  // The same board found under two names (e.g. "Airbus" and "Airbus Defence and Space") is read once.
  return [...new Map(boards.map((b) => [`${b.kind}:${b.id.toLowerCase()}`, b])).values()];
}

// --- Reading postings

const TITLE: Record<Exclude<Kind, "masters">, RegExp> = {
  internship: /\b(intern(ship)?s?|placement|praktik(um|ant(in)?)|pflichtpraktikum|stagiaire|stage (de|d['’]|en|ing[ée]nieur)|pr[áa]cticas|becari[oa]|co-?op|tirocinio|stagiair)\b/i,
  alternance: /alternan|apprenti|apprentissage|professionnalisation|work[- ]study/i,
  job: /graduate|junior|entry[- ]level|early career|ing[ée]nieur|engineer|analyst|associate|jeune dipl[oô]m[ée]|\bv\.?i\.?e\b|technician|specialist|consultant/i,
};
const NOT_FOR: Record<Exclude<Kind, "masters">, RegExp> = {
  internship: /werkstudent|working student|abschlussarbeit|thesis|masterarbeit|bachelorarbeit|apprentic|alternan|ausbildung|duales studium|ph\.?d|doctoral|graduate (program|scheme)|\bsenior\b/i,
  alternance: /\bsenior\b|manager|thesis|ph\.?d/i,
  job: /intern(ship)?|placement|praktik|stagiaire|alternan|apprenti|thesis|ph\.?d|\bsenior\b|\bsr\.?\b|\blead\b|principal|\bstaff\b|manager|director|head of|chief|vice president|\bvp\b|expert/i,
};
const SEARCH_TERMS: Record<Exclude<Kind, "masters">, string[]> = {
  internship: ["intern", "internship", "placement", "praktikum", "stagiaire", "prácticas"],
  alternance: ["alternance", "apprenti", "apprentissage"],
  job: ["graduate", "junior", "engineer", "ingénieur"],
};

type Listed = { company: string; title: string; place: string; url: string; details: () => Promise<{ text: string; place?: string }> };

async function listBoard(b: Board, kind: Exclude<Kind, "masters">): Promise<Listed[]> {
  const out: Listed[] = [];
  const seen = new Set<string>();
  const push = (p: Listed) => {
    if (!seen.has(p.url)) {
      seen.add(p.url);
      out.push(p);
    }
  };
  if (b.kind === "smartrecruiters") {
    for (const term of SEARCH_TERMS[kind]) {
      for (let offset = 0; offset < 300; offset += 100) {
        const j = await getJson<{ content?: { id: string; name: string; location?: { city?: string; country?: string } }[] }>(
          `https://api.smartrecruiters.com/v1/companies/${b.id}/postings?q=${encodeURIComponent(term)}&limit=100&offset=${offset}`,
        );
        for (const p of j?.content ?? []) {
          push({
            company: b.company,
            title: p.name,
            place: [p.location?.city, p.location?.country].filter(Boolean).join(", "),
            url: `https://jobs.smartrecruiters.com/${b.id}/${p.id}`,
            details: async () => {
              const d = await getJson<{ jobAd?: { sections?: Record<string, { text?: string }> } }>(
                `https://api.smartrecruiters.com/v1/companies/${b.id}/postings/${p.id}`,
              );
              return { text: strip(Object.values(d?.jobAd?.sections ?? {}).map((s) => s.text).join(" ")) };
            },
          });
        }
        if ((j?.content ?? []).length < 100) break;
      }
    }
  } else if (b.kind === "greenhouse") {
    const j = await getJson<{ jobs?: { id: number; title: string; location?: { name?: string }; content?: string }[] }>(
      `https://boards-api.greenhouse.io/v1/boards/${b.id}/jobs?content=true`,
    );
    for (const p of j?.jobs ?? []) {
      // The board's own link: BAPTOU's posting check reads it through Greenhouse's API.
      push({ company: b.company, title: p.title, place: p.location?.name ?? "", url: `https://job-boards.greenhouse.io/${b.id}/jobs/${p.id}`, details: async () => ({ text: strip(p.content) }) });
    }
  } else if (b.kind === "lever") {
    let j = await getJson<{ id: string; text: string; hostedUrl: string; categories?: { location?: string }; country?: string; descriptionPlain?: string; lists?: { content?: string }[] }[]>(
      `https://api.lever.co/v0/postings/${b.id}?mode=json`,
    );
    if (!Array.isArray(j) || !j.length) j = await getJson(`https://api.eu.lever.co/v0/postings/${b.id}?mode=json`);
    for (const p of j ?? []) {
      push({
        company: b.company,
        title: p.text,
        place: [p.categories?.location, p.country].filter(Boolean).join(", "),
        url: p.hostedUrl,
        details: async () => ({ text: strip(`${p.descriptionPlain ?? ""} ${(p.lists ?? []).map((l) => l.content).join(" ")}`) }),
      });
    }
  } else if (b.kind === "ashby") {
    const j = await getJson<{ jobs?: { title: string; location?: string; jobUrl: string; descriptionPlain?: string; descriptionHtml?: string }[] }>(
      `https://api.ashbyhq.com/posting-api/job-board/${b.id}`,
    );
    for (const p of j?.jobs ?? []) {
      push({ company: b.company, title: p.title, place: p.location ?? "", url: p.jobUrl, details: async () => ({ text: strip(p.descriptionPlain ?? p.descriptionHtml) }) });
    }
  } else {
    const wd = workday(b.id);
    if (!wd) return out;
    for (const term of SEARCH_TERMS[kind]) {
      for (let offset = 0; offset < 100; offset += 20) {
        const j = await getJson<{ jobPostings?: { title: string; externalPath?: string; locationsText?: string }[] }>(`${wd.api}/jobs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: term }),
        });
        const posts = j?.jobPostings ?? [];
        for (const p of posts) {
          if (!p.externalPath) continue;
          push({
            company: b.company,
            title: p.title,
            place: p.locationsText ?? "",
            url: `${wd.host}/${wd.site}${p.externalPath}`,
            details: async () => {
              const d = await getJson<{ jobPostingInfo?: { jobDescription?: string; location?: string; country?: { descriptor?: string } } }>(`${wd.api}${p.externalPath}`);
              const info = d?.jobPostingInfo;
              return { text: strip(info?.jobDescription), place: [info?.location, info?.country?.descriptor].filter(Boolean).join(", ") };
            },
          });
        }
        if (posts.length < 20) break;
      }
    }
  }
  return out;
}

/** The sentences a scout needs to judge a posting: dates, length, languages, eligibility (not the company blurb). */
function keyDetails(text: string) {
  const sentences = text.split(/(?<=[.!?;])\s+|\s(?=[A-Z][a-z]+:)|\s(?=\d\)\s)/);
  const KEY = /start|beginn|début|inicio|duration|dauer|durée|duración|month|monat|mois|mes(es)?\b|week|semaine|202\d|language|sprach|langue|idioma|english|german|deutsch|french|français|spanish|right to work|work permit|visa|sponsor|eligib|enrol|immatrikul|degree|studium|year of study|you will|your tasks|aufgaben|missions?\b/i;
  const BLURB = /employees|associates|worldwide|countries|global (player|leader)|billion|milliard|founded|we are proud|#like|benefit|canteen|insurance|medical office/i;
  const picked = sentences.filter((s) => KEY.test(s) && !BLURB.test(s)).map((s) => s.trim().slice(0, 200));
  return (picked.length ? picked : [text.slice(0, 300)]).join(" … ").slice(0, 600);
}

export type PostingFilter = {
  kind: Exclude<Kind, "masters">;
  include?: string[]; // words one of which the title should contain (e.g. mechanical, vehicle, test)
  exclude?: string[]; // words that rule a title out (e.g. finance, marketing)
  excludePlaces?: string[]; // countries or cities the student rules out
  preferPlaces?: string[]; // countries or cities the student prefers: their postings come first
  year?: number; // the year the offer should start: titles naming only other years are dropped
};

const wordsRegex = (words: string[] | undefined) => {
  const clean = (words ?? []).map((w) => w.trim()).filter((w) => w.length >= 2).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return clean.length ? new RegExp(`(${clean.join("|")})`, "i") : null;
};

/**
 * The postings on these boards that could fit: the right kind of offer, a title on topic, not in a place the
 * student rules out, each with its key details. Free; takes about a minute.
 */
export async function collectPostings(boards: Board[], filter: PostingFilter, { maxDetails = 160, maxReturned = 45, perCompany = 6 } = {}) {
  const include = wordsRegex(filter.include);
  const exclude = wordsRegex(filter.exclude);
  const banned = wordsRegex(filter.excludePlaces);
  const preferred = wordsRegex(filter.preferPlaces);
  // "Internship 2026" when the student wants 2027: a past or other cycle.
  const otherYear = (title: string) => {
    const years = (title.match(/20[2-3]\d/g) ?? []).map(Number);
    return !!filter.year && years.length > 0 && !years.includes(filter.year);
  };
  const listed = (await pool(boards, 5, (b) => listBoard(b, filter.kind).catch(() => [] as Listed[]))).flat();
  const onTopic = listed.filter(
    (p) =>
      TITLE[filter.kind].test(p.title) &&
      !NOT_FOR[filter.kind].test(p.title) &&
      (!include || include.test(p.title)) &&
      !(exclude && exclude.test(p.title)) &&
      !(banned && banned.test(p.place)) &&
      !otherYear(p.title),
  );
  // Titles naming more of the wanted words, in the preferred places, for the right year, first.
  const score = (p: Listed) =>
    2 * (include ? (p.title.match(new RegExp(include.source, "gi"))?.length ?? 0) : 0) +
    (preferred && preferred.test(p.place) ? 3 : 0) +
    (filter.year && p.title.includes(String(filter.year)) ? 2 : 0);
  // A few per company in turn, so one big employer doesn't fill the list.
  const ranked = onTopic.sort((a, b) => score(b) - score(a));
  const perCo = new Map<string, number>();
  const shortlist: Listed[] = [];
  for (const p of ranked) {
    const n = perCo.get(p.company) ?? 0;
    if (n >= perCompany * 3) continue; // details are read for a few spares per company
    perCo.set(p.company, n + 1);
    shortlist.push(p);
    if (shortlist.length >= maxDetails) break;
  }
  const detailed = await pool(shortlist, 8, async (p): Promise<BoardPosting | null> => {
    const d = await p.details().catch(() => ({ text: "" }) as { text: string; place?: string });
    const place = d.place || p.place;
    if (banned && banned.test(place)) return null;
    return { company: p.company, title: p.title, place, url: p.url, details: keyDetails(d.text) };
  });
  const kept = new Map<string, number>();
  const postings = detailed
    .filter((p): p is BoardPosting => !!p)
    .filter((p) => {
      const n = kept.get(p.company) ?? 0;
      kept.set(p.company, n + 1);
      return n < perCompany;
    })
    .slice(0, maxReturned);
  logger.info("Board postings", { boards: boards.length, listed: listed.length, onTopic: onTopic.length, returned: postings.length });
  return { postings, listed: listed.length, onTopic: onTopic.length };
}
