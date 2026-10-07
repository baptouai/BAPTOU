import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getFunctions } from "firebase-admin/functions";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onTaskDispatched } from "firebase-functions/v2/tasks";
import { z } from "zod";
import { type AgentStats, loadProfile, runAgent, today } from "./agent.js";
import { loadDismissed, looseOfferKey, offerKey, urlId } from "./offers.js";
import { checkPostings, isOfficial, looksGeneric } from "./postings.js";
import { type NewOffer, notifyNewOffers } from "./notify.js";
import { GMAIL_SECRETS } from "./gmail.js";
import { anthropicKey, db, type Kind, MODELS, REGION } from "./shared.js";

// users/{uid}/searches/{searchId}, created by the user in the app. BAPTOU never searches without one.
// Calibrated so that 90+ ("almost ideal") is rare: the user gets a dedicated email for those.
const SCORE_SCALE =
  "0 to 100. 90+ only when it matches almost everything (role, field, location, dates, level, languages, requirements the student meets); 75-89 strong match with one gap; 60-74 decent; below 60 weak, only to complete the list";

type Search = {
  kind?: Kind; // missing = internship (searches created before other kinds existed)
  name: string;
  roles: string;
  locations: string;
  workMode: "any" | "onsite" | "hybrid" | "remote";
  duration: string;
  startDate: string;
  industries: string;
  languages: string;
  notes: string;
  tuitionBudget?: string; // master's searches
  contractType?: string; // jobs: permanent / fixed-term; alternances: apprentissage / professionnalisation
  salaryMin?: string; // jobs
  rhythm?: string; // alternances, e.g. "3 weeks company / 1 week school"
  school?: string; // alternances: the student's school, or empty if they still need one
  nextLeads?: string[]; // what the previous run didn't have time to check
  frequencyDays?: number; // 1, 3 or 7; missing = every day
  emptyStreak?: number; // consecutive runs that found nothing
  nextRunAt?: Timestamp | null; // the daily job skips the search until then
  maxPerRun: number;
  status: "active" | "paused" | "stopped" | "ended";
  endsAt: Timestamp | null; // null = until the user stops it
  runState?: "idle" | "queued" | "running" | "error";
};

export const OffersSchema = z.object({
  offers: z.array(
    z.object({
      title: z.string(),
      organization: z.string(),
      location: z.string(),
      country: z.string(),
      url: z.string().describe("Direct link to the posting or its application page"),
      deadline: z.string().describe("YYYY-MM-DD, or empty if not stated"),
      startDate: z.string().describe("As stated in the posting, or empty"),
      duration: z.string().describe("As stated in the posting, or empty"),
      postingLanguage: z.string().describe("Language the posting is written in"),
      matchScore: z.number().describe(SCORE_SCALE),
      matchReason: z.string().describe("2-4 reasons this fits the student, citing their profile. Bullet points: one per line, each starting with '- ', max 12 words each, no paragraphs. Never a placeholder."),
      companyBrief: z.string().describe("3-5 facts on the company: what it does, size, recent news, culture. Bullet points: one per line, each starting with '- ', max 12 words each, no paragraphs."),
    }),
  ),
  summary: z.string().describe("One short sentence for the student (max 25 words): what this run found, even if it stopped early. Never a placeholder."),
  leadsToCheckNext: z
    .array(z.string())
    .describe("Up to 8 web searches worth trying next run (organizations or queries you didn't get to), written as search queries, not careers-page links"),
});

// Jobs and alternances add contract details to the same offer fields.
export const offerItem = OffersSchema.shape.offers.element;
export const JobsSchema = OffersSchema.extend({
  offers: z.array(
    offerItem.extend({
      contractType: z.string().describe("Permanent, fixed-term, graduate programme… as stated, or empty"),
      salary: z.string().describe("Salary as stated in the posting, or empty"),
    }),
  ),
});
export const AlternanceSchema = OffersSchema.extend({
  offers: z.array(
    offerItem.extend({
      contractType: z.string().describe("Contrat d'apprentissage, contrat de professionnalisation, or empty if not stated"),
      rhythm: z.string().describe("Company / school rhythm as stated (e.g. 3 weeks / 1 week), or empty"),
      school: z.string().describe("Partner school or programme named in the posting, or empty"),
      salary: z.string().describe("Pay as stated, or empty"),
    }),
  ),
});

const JOB_SYSTEM = `You are BAPTOU's job scout. You search the web for real, currently open entry-level and graduate jobs that fit a young graduate's profile and search criteria.

Rules:
- Only return postings you actually found during this run (in search results or pages you opened). Never invent a posting, company or link.
- Only offers that are open now: skip anything closed, filled, expired or past its deadline. Search results keep postings long after they close, so prefer recent ones (this year's recruitment cycle) and skip any whose dates show a past cycle, e.g. "2025-26" or posted over 6 months ago.
- Official sources first: the url must be the posting on the organization's own careers site or its official application system (Workday, Greenhouse, Lever, SuccessFactors, Taleo, Teamtailor, SmartRecruiters, iCIMS…). Use job boards (LinkedIn, Indeed, Glassdoor, JobTeaser, Welcome to the Jungle…) to discover offers, then find the same posting on the official site; give a job-board link only when the organization doesn't publish the offer itself. The url must lead to that specific posting, never to a general careers page.
- Find postings with web searches, not by browsing careers sites: those are often empty without JavaScript and waste your limits. Use targeted queries such as site:myworkdayjobs.com, site:greenhouse.io, site:lever.co, site:smartrecruiters.com or site:successfactors.com with role, place and year keywords, and "<company> internship 2027" style queries for specific organizations.
- A posting seen in search results (its title, organization and own link) is enough: you don't need to open it to confirm it's open, BAPTOU checks every link afterwards. Open a posting only for details the result doesn't show.
- Spread your searches over many organizations: at most 2 searches per organization, and favour queries that return several postings at once. Never run the same query twice: each search must differ from the ones before. If your first searches give too few, widen: related industries and roles, other locations the student accepts (read their notes). Say so in matchReason.
- Entry-level, junior or graduate roles only, unless the student asks otherwise. Skip internships, alternances and senior roles.
- Respect the criteria (roles, locations, work mode, contract type, minimum salary, start date, languages). Mention any compromise in matchReason.
- Use the student's nationalities (in the profile) for work permits: don't skip postings that require a right to work the student has, and flag visa sponsorship needs in matchReason.
- Always return the number of offers asked for: returning fewer is a failure unless nothing open exists at all. When strong matches run out, widen the search and fill the list with the best real, open offers you can find, even if they aren't ideal: give them a lower matchScore and say what doesn't fit in matchReason. Rank by matchScore, highest first.
- Never relax the firm requirements to fill the list: the start date window and duration the student gave, eligibility (a required university, country of study, nationality or right to work, degree level), and anything like what they turned down. Only preferences can be relaxed: industry, company size, exact role, locations within what the student accepts.
- Skip any posting in the "already suggested" or "turned down" lists, and anything very similar to what the student turned down.
- Start with the leads the previous run didn't have time to check, if any.
- If you run out of searches, return what you found so far rather than nothing, and list what you didn't have time to check in leadsToCheckNext.
When you are done, call submit_offers exactly once.`;

const ALTERNANCE_SYSTEM = `You are BAPTOU's alternance scout. You search the web for real, currently open alternance offers in France (contrat d'apprentissage or contrat de professionnalisation) that fit a student's profile and search criteria.

Rules:
- Only return offers you actually found during this run (in search results or pages you opened). Never invent an offer, company or link.
- Only offers that are open now: skip anything closed, filled, expired or past its deadline. When a search result doesn't make this clear, open the posting to check.
- Official sources first: the url should be the offer on the company's own careers site or its application system. La bonne alternance, France Travail, HelloWork, Welcome to the Jungle, JobTeaser and Indeed France are good for finding offers; give their link only when the company doesn't publish the offer itself. The url must lead to that specific offer.
- Find postings with web searches, not by browsing careers sites: those are often empty without JavaScript and waste your limits. Use targeted queries such as site:myworkdayjobs.com, site:greenhouse.io, site:lever.co, site:smartrecruiters.com or site:successfactors.com with role, place and year keywords, and "<company> alternance 2027" style queries for specific organizations.
- A posting seen in search results (its title, organization and own link) is enough: you don't need to open it to confirm it's open, BAPTOU checks every link afterwards. Open a posting only for details the result doesn't show.
- Spread your searches over many organizations: at most 2 searches per organization, and favour queries that return several postings at once. Never run the same query twice: each search must differ from the ones before. If your first searches give too few, widen: related industries and roles, other locations the student accepts (read their notes). Say so in matchReason.
- Alternance offers only (not internships or regular jobs). Most start in September; check the start date and the contract length (usually 1 to 3 years).
- Respect the criteria (roles, locations, contract type, rhythm, start date). Mention any compromise in matchReason.
- The school matters: if the student already has a school, prefer offers compatible with its programme and rhythm; if they still need one, favour offers whose company names a partner school, and say so in matchReason.
- Always return the number of offers asked for: returning fewer is a failure unless nothing open exists at all. When strong matches run out, widen the search and fill the list with the best real, open offers you can find, even if they aren't ideal: give them a lower matchScore and say what doesn't fit in matchReason. Rank by matchScore, highest first.
- Never relax the firm requirements to fill the list: the start date window and duration the student gave, eligibility (a required university, country of study, nationality or right to work, degree level), and anything like what they turned down. Only preferences can be relaxed: industry, company size, exact role, locations within what the student accepts.
- Skip any offer in the "already suggested" or "turned down" lists, and anything very similar to what the student turned down.
- Start with the leads the previous run didn't have time to check, if any.
- If you run out of searches, return what you found so far rather than nothing, and list what you didn't have time to check in leadsToCheckNext.
When you are done, call submit_offers exactly once.`;

const SYSTEM = `You are BAPTOU's internship scout. You search the web for real, currently open internship postings that fit a student's profile and search criteria.

Rules:
- Only return postings you actually found during this run (in search results or pages you opened). Never invent a posting, company or link.
- Only offers that are open now: skip anything closed, filled, expired or past its deadline. When a search result doesn't make this clear, open the posting to check.
- Official sources first: the url must be the posting on the organization's own careers site or its official application system (Workday, Greenhouse, Lever, SuccessFactors, Taleo, Teamtailor, SmartRecruiters, iCIMS…). Use job boards (LinkedIn, Indeed, Glassdoor, JobTeaser, Welcome to the Jungle…) to discover offers, then find the same posting on the official site; give a job-board link only when the organization doesn't publish the offer itself. The url must lead to that specific posting, never to a general careers page.
- Find postings with web searches, not by browsing careers sites: those are often empty without JavaScript and waste your limits. Use targeted queries such as site:myworkdayjobs.com, site:greenhouse.io, site:lever.co, site:smartrecruiters.com or site:successfactors.com with role, place and year keywords, and "<company> internship 2027" style queries for specific organizations.
- A posting seen in search results (its title, organization and own link) is enough: you don't need to open it to confirm it's open, BAPTOU checks every link afterwards. Open a posting only for details the result doesn't show.
- Spread your searches over many organizations: at most 2 searches per organization, and favour queries that return several postings at once. Never run the same query twice: each search must differ from the ones before. If your first searches give too few, widen: related industries and roles, other locations the student accepts (read their notes). Say so in matchReason.
- Respect the search criteria (roles, locations, work mode, duration, start date, languages). Mention any compromise in matchReason.
- Use the student's nationalities (in the profile) for work permits: don't skip postings that require a right to work the student has, and flag visa sponsorship needs in matchReason.
- Always return the number of offers asked for: returning fewer is a failure unless nothing open exists at all. When strong matches run out, widen the search and fill the list with the best real, open offers you can find, even if they aren't ideal: give them a lower matchScore and say what doesn't fit in matchReason. Rank by matchScore, highest first.
- Never relax the firm requirements to fill the list: the start date window and duration the student gave, eligibility (a required university, country of study, nationality or right to work, degree level), and anything like what they turned down. Only preferences can be relaxed: industry, company size, exact role, locations within what the student accepts.
- Skip any posting in the "already suggested" or "turned down" lists, and anything very similar to what the student turned down.
- Start with the leads the previous run didn't have time to check, if any.
- If you run out of searches, return what you found so far rather than nothing, and list what you didn't have time to check in leadsToCheckNext.
When you are done, call submit_offers exactly once.`;

// Master's programmes reuse the offer fields: title = programme, organization = university,
// url = the programme's admissions page, startDate = intake, companyBrief = programme facts.
export const ProgrammesSchema = z.object({
  offers: z.array(
    z.object({
      title: z.string().describe("Programme name, e.g. MSc Mechanical Engineering"),
      organization: z.string().describe("University"),
      location: z.string().describe("City"),
      country: z.string(),
      url: z.string().describe("The programme's page or its application page on the university's website"),
      deadline: z.string().describe("Next application deadline for the requested intake, YYYY-MM-DD, or empty if not stated"),
      startDate: z.string().describe("Intake, e.g. September 2027"),
      duration: z.string().describe("Programme length, e.g. 1 year"),
      postingLanguage: z.string().describe("Language of instruction"),
      matchScore: z.number().describe(SCORE_SCALE),
      matchReason: z.string().describe("2-4 reasons this programme fits the student's degree, grades and goals. Bullet points: one per line, each starting with '- ', max 12 words each, no paragraphs. Never a placeholder."),
      companyBrief: z
        .string()
        .describe("4-6 facts: tuition per year for this student, admission requirements (degree, grades, tests such as GRE/IELTS), reputation, career outcomes. Bullet points: one per line, each starting with '- ', max 12 words each, no paragraphs."),
    }),
  ),
  summary: z.string().describe("One short sentence for the student (max 25 words): what this run found, even if it stopped early. Never a placeholder."),
  leadsToCheckNext: z
    .array(z.string())
    .describe("Up to 8 web searches worth trying next run (organizations or queries you didn't get to), written as search queries, not careers-page links"),
});

const MASTERS_SYSTEM = `You are BAPTOU's admissions scout. You search the web for master's programmes that fit a student who already holds a bachelor's degree, for programmes they apply to directly on the university's website.

Rules:
- Only return programmes you actually found during this run, with their official university page. Never invent a programme, university or link.
- The url must be the programme's own page or its application page on the university's website. Ranking and aggregator sites (Mastersportal, FindAMasters…) are only for finding programmes.
- The application window for the requested intake must still be open, or open later. Skip programmes whose deadline has passed.
- Respect the criteria (fields, countries, intake, teaching language, tuition budget). Check the student's degree and grades against the admission requirements and say so in matchReason; mention any compromise.
- Use the student's nationalities (in the profile) for tuition: give the fee that applies to them (home, EU or international) and any visa need.
- Give real figures in the brief when the university publishes them (tuition for the student's situation, requirements, deadlines).
- Always return the number of programmes asked for. When strong matches run out, fill the list with the best real programmes still open to applications, even if they aren't ideal: give them a lower matchScore and say what doesn't fit in matchReason. Rank by matchScore, highest first.
- Skip anything in the "already suggested" or "turned down" lists, and anything very similar to what the student turned down.
- Start with the leads the previous run didn't have time to check, if any.
- If you run out of searches, return what you found so far rather than nothing, and list what you didn't have time to check in leadsToCheckNext.
When you are done, call submit_offers exactly once.`;

/**
 * When the daily job should run this search next: after its normal interval when the run found
 * something, and backing off (2x, 4x… up to a week) after runs that found nothing.
 */
function nextRunAfter(search: Search, created: number) {
  const base = search.frequencyDays ?? 1;
  const emptyStreak = created > 0 ? 0 : (search.emptyStreak ?? 0) + 1;
  const days = Math.min(base * 2 ** emptyStreak, Math.max(7, base));
  // At 04:00 UTC on that day (before the 07:00 Paris job), so an evening run doesn't skip the next morning.
  const target = new Date(Date.now() + days * 86_400_000);
  target.setUTCHours(4, 0, 0, 0);
  const nextRunAt = Timestamp.fromDate(target);
  return { emptyStreak, nextRunAt };
}

const NOUN: Record<Kind, string> = {
  internship: "internship offers",
  job: "job offers",
  alternance: "alternance offers",
  masters: "master's programmes",
};

/** The listed string fields of an offer that are present and non-empty. */
function pick(o: object, keys: string[]) {
  return Object.fromEntries(
    keys.map((k) => [k, (o as Record<string, unknown>)[k]]).filter(([, v]) => typeof v === "string" && v),
  );
}

// When a run stops at its limits, the model sometimes fills a text with "placeholder": show nothing instead.
const real = (text: string) => (/^\s*(placeholder|n\/?a|tbd|todo|none|-)\s*\.?\s*$/i.test(text) ? "" : text);

function parseDate(s: string): Timestamp | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T23:59:59Z`);
  return Number.isNaN(d.getTime()) ? null : Timestamp.fromDate(d);
}

async function runSearch(uid: string, searchId: string) {
  const searchRef = db.doc(`users/${uid}/searches/${searchId}`);
  const search = (await searchRef.get()).data() as Search | undefined;
  if (!search || search.status !== "active") return;

  await searchRef.update({ runState: "running", lastError: FieldValue.delete() });
  try {
    const profile = await loadProfile(uid);
    const kind = search.kind ?? "internship";
    const existing = await db
      .collection(`users/${uid}/applications`)
      .where("type", "==", kind)
      .select("applyUrl", "title", "organization")
      .get();
    const seen = existing.docs.map((d) => d.get("applyUrl")).filter(Boolean);
    const existingKeys = new Set(
      existing.docs.flatMap((d) => [
        offerKey(d.get("organization") ?? "", d.get("title") ?? ""),
        looseOfferKey(d.get("organization") ?? "", d.get("title") ?? ""),
      ]),
    );
    // Turned-down offers are deleted but remembered: never suggested again, and their reasons guide the search.
    const dismissed = await loadDismissed(uid);
    // No product limit on offers per run; 50 only guards against typos (e.g. 500) and oversized answers.
    const maxPerRun = Math.min(Math.max(Math.round(search.maxPerRun) || 5, 1), 50);

    const criteria =
      kind === "masters"
        ? `Search criteria:
- Fields / programmes: ${search.roles}
- Countries: ${search.locations || "any"}
- Intake: ${search.startDate || "any"}
- Programme length: ${search.duration || "any"}
- Teaching languages: ${search.languages || "any"}
- Tuition budget per year: ${search.tuitionBudget || "not stated"}
- Notes from the student: ${search.notes || "none"}
`
        : kind === "alternance"
          ? `Search criteria:
- Roles / keywords: ${search.roles}
- Locations: ${search.locations || "any"}
- Contract type: ${search.contractType || "apprentissage or professionnalisation"}
- Rhythm: ${search.rhythm || "any"}
- School: ${search.school ? `already has one: ${search.school}` : "still needs a school"}
- Start date: ${search.startDate || "any"}
- Contract length: ${search.duration || "any"}
- Notes from the student: ${search.notes || "none"}
`
          : `Search criteria:
- Roles / keywords: ${search.roles}
- Locations: ${search.locations || "any"}
- Work mode: ${search.workMode}
${kind === "job" ? `- Contract type: ${search.contractType || "any"}\n- Minimum salary: ${search.salaryMin || "not stated"}` : `- Duration: ${search.duration || "any"}`}
- Start date: ${search.startDate || "any"}
- Industries: ${search.industries || "any"}
- Languages: ${search.languages || "any"}
- Notes from the student: ${search.notes || "none"}
`;
    const lists = `Already suggested (skip these): ${seen.length ? seen.slice(0, 150).join("\n") : "none"}
Turned down (never suggest again): ${dismissed.urls.length ? dismissed.urls.slice(0, 150).join("\n") : "none"}`;

    /** One scouting pass for `count` offers, within its own browsing and spending limits. */
    const scout = (count: number, limits: { searches: number; fetches: number; usd: number }, extra: string, stats: AgentStats) =>
      runAgent({
        uid,
        system: { internship: SYSTEM, job: JOB_SYSTEM, alternance: ALTERNANCE_SYSTEM, masters: MASTERS_SYSTEM }[kind],
        model: MODELS.search,
        task: "search",
        // Searches are cheap ($0.01); reading pages is what costs, and pages are size-capped in runAgent.
        web: { searches: limits.searches, fetches: limits.fetches },
        effort: "low",
        maxPageTokens: 4000,
        maxRunUsd: limits.usd,
        stats,
        submit: {
          name: "submit_offers",
          description: `Return the ${NOUN[kind]} found in this run.`,
          schema: { internship: OffersSchema, job: JobsSchema, alternance: AlternanceSchema, masters: ProgrammesSchema }[kind],
        },
        prompt: [
          // Same first block in every pass and run, so it is served from the prompt cache.
          { type: "text", text: `Student profile:\n${JSON.stringify(profile, null, 2)}` },
          {
            type: "text",
            text: `Today is ${today()}. If the start date or intake asked for has already passed, the student means the next one (the same month next year): search for that, and say so in the summary.\n${criteria}\n${extra}Find ${count} new ${NOUN[kind]}.\n${lists}`,
          },
        ],
      });

    // The student asked for `maxPerRun` offers. BAPTOU asks for a few spares, since some links turn out to be
    // closed or to be a careers page, and keeps the best ones that pass the checks.
    const spare = Math.min(6, Math.ceil(maxPerRun / 2) + 2);
    const firstStats: AgentStats = { costUsd: 0 };
    const first = await scout(
      maxPerRun + spare,
      // Searches cost about $0.02 each; an opened page about $0.03 and makes every later step dearer, so few.
      { searches: Math.min(8 + 2 * maxPerRun, 30), fetches: Math.min(2 + Math.ceil(maxPerRun / 3), 8), usd: 0.15 + 0.04 * maxPerRun },
      `${dismissed.reasons.length ? `The student turned down these earlier suggestions. Learn from their reasons and avoid similar offers:\n${dismissed.reasons.join("\n")}\n\n` : ""}${search.nextLeads?.length ? `The previous run suggested these searches; try them first:\n${search.nextLeads.map((l) => `- ${l}`).join("\n")}\n\n` : ""}`,
      firstStats,
    );

    type Offer = (typeof first.offers)[number];
    const taken = new Set<string>(); // urls and organization+title of the offers kept this run
    const rejected: string[] = []; // links dropped this run, so a second pass doesn't return them
    let dropped = 0;

    /** The best `n` offers that pass the checks: open, a specific posting, new, official postings first. */
    async function choose(offers: Offer[], n: number) {
      const candidates = offers.filter((o) => {
        const id = urlId(o.url);
        const key = offerKey(o.organization, o.title);
        const loose = looseOfferKey(o.organization, o.title);
        // Hard guarantee, whatever the model returned: turned-down and already-listed offers never come back,
        // nor the same offer twice (e.g. on the company's site and on a job board).
        if (
          dismissed.urlIds.has(id) ||
          dismissed.offerKeys.has(key) ||
          dismissed.looseKeys.has(loose) ||
          existingKeys.has(key) ||
          existingKeys.has(loose) ||
          taken.has(id) ||
          taken.has(loose)
        ) {
          return false;
        }
        const deadline = parseDate(o.deadline);
        if (deadline && deadline.toMillis() < Date.now()) {
          dropped++;
          rejected.push(o.url);
          return false;
        }
        return true;
      });
      // Dead links (removed, filled or expired postings) and links to a careers section never reach the student.
      // Plain HTTP checks, no AI.
      const links = await checkPostings(candidates.map((o) => ({ url: o.url, organization: o.organization })));
      const usable = candidates.filter((o) => {
        if (links.get(o.url)?.status !== "closed" && !looksGeneric(o.url)) return true;
        dropped++;
        rejected.push(o.url);
        return false;
      });
      // Official postings rank above job-board copies, and verified-open links above unverifiable ones.
      const rank = (o: Offer) =>
        o.matchScore + (isOfficial(o.url, o.organization) ? 10 : 0) + (links.get(o.url)?.status === "open" ? 5 : 0);
      // Best first; the same offer found twice in this answer is kept once (its best-ranked copy).
      const best: Offer[] = [];
      for (const o of usable.sort((a, b) => rank(b) - rank(a))) {
        if (best.length >= n) break;
        const loose = looseOfferKey(o.organization, o.title);
        if (taken.has(loose)) continue;
        taken.add(urlId(o.url)).add(loose);
        best.push(o);
      }
      return best;
    }

    const picked = await choose(first.offers, maxPerRun);
    let summary = real(first.summary);
    let leads = first.leadsToCheckNext;
    const secondStats: AgentStats = { costUsd: 0 };

    // Still short: one smaller pass for the missing ones, when it can help, i.e. links were dropped or the
    // first pass ran out of limits. If it simply found nothing more, a second pass would find nothing either.
    if (picked.length < maxPerRun && (dropped > 0 || firstStats.limited)) {
      const missing = maxPerRun - picked.length;
      try {
        const second = await scout(
          missing + 2,
          { searches: Math.min(3 + 2 * missing, 10), fetches: Math.min(1 + Math.ceil(missing / 2), 4), usd: 0.05 + 0.03 * missing },
          `This is a second pass: the first one this run came up short.
Found earlier this run (skip them): ${picked.map((o) => o.url).join("\n") || "none"}
Closed, expired or not a specific posting (skip them): ${rejected.join("\n") || "none"}
${leads.length ? `Leads you could start with:\n${leads.map((l) => `- ${l}`).join("\n")}\n` : ""}
`,
          secondStats,
        );
        const more = await choose(second.offers, missing);
        picked.push(...more);
        leads = second.leadsToCheckNext;
        if (more.length) summary = `${first.summary} A second pass added ${more.length} more.`;
      } catch (e) {
        // Out of allowance, or a failed pass: keep what the first pass found.
        logger.warn("Search top-up failed", { uid, searchId, error: String(e) });
      }
    }

    let created = 0;
    const fresh: NewOffer[] = []; // this run's new offers, for the email to the user
    const batchAt = Timestamp.now(); // groups this run's offers into the "Latest batch" list
    for (const o of picked) {
      const id = urlId(o.url);
      const matchScore = Math.round(Math.min(Math.max(o.matchScore, 0), 100));
      try {
        await db.doc(`users/${uid}/applications/${id}`).create({
          type: kind,
          status: "suggested",
          searchId,
          batchAt,
          title: o.title,
          organization: o.organization,
          country: o.country,
          location: o.location,
          applyUrl: o.url,
          ...(isOfficial(o.url, o.organization) ? {} : { fromJobBoard: true }),
          deadline: parseDate(o.deadline),
          startDate: o.startDate,
          duration: o.duration,
          postingLanguage: o.postingLanguage,
          matchScore,
          matchReason: real(o.matchReason),
          research: real(o.companyBrief),
          // Contract details for jobs and alternances (absent on other kinds).
          ...pick(o, ["contractType", "salary", "rhythm", "school"]),
          letter: "",
          packFields: [],
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        created++;
        fresh.push({ id, title: o.title, organization: o.organization, location: o.location, matchScore, matchReason: real(o.matchReason), deadline: o.deadline });
      } catch {
        // Already exists: same posting suggested before.
      }
    }

    await searchRef.update({
      runState: "idle",
      lastRunAt: FieldValue.serverTimestamp(),
      lastBatchAt: batchAt,
      lastRunCreated: created,
      lastRunDropped: dropped, // offers whose posting turned out to be closed, expired or not a posting
      lastRunCostUsd: Math.round((firstStats.costUsd + secondStats.costUsd) * 100) / 100,
      ...nextRunAfter(search, created),
      nextLeads: leads.slice(0, 8),
      lastRunSummary: `${created} new offer${created === 1 ? "" : "s"}. ${summary}`,
      totalFound: FieldValue.increment(created),
    });
    await notifyNewOffers(uid, searchId, search.name, fresh);
  } catch (e) {
    logger.error("runSearch failed", { uid, searchId, error: String(e) });
    await searchRef.update({
      runState: "error",
      lastError: e instanceof HttpsError ? e.message : "The search failed. It will try again tomorrow.",
    });
  }
}

const queue = () => getFunctions().taskQueue(`locations/${REGION}/functions/runSearchTask`);

// A search pauses when this many runs' worth of its offers (at least 10) are waiting unreviewed.
const BACKLOG_RUNS = 3;

/** One search run, dispatched by Cloud Tasks so many users' searches run in parallel. */
export const runSearchTask = onTaskDispatched<{ uid: string; searchId: string }>(
  {
    region: REGION,
    secrets: [anthropicKey, ...GMAIL_SECRETS], // Gmail: the new-offer email
    timeoutSeconds: 900,
    memory: "512MiB",
    retryConfig: { maxAttempts: 1 },
    rateLimits: { maxConcurrentDispatches: 5 },
  },
  async (req) => runSearch(req.data.uid, req.data.searchId),
);

/** Every morning: end expired searches and queue a run for every active one. */
export const dailySearches = onSchedule(
  { region: REGION, schedule: "every day 07:00", timeZone: "Europe/Paris" },
  async () => {
    const active = await db.collectionGroup("searches").where("status", "==", "active").get();
    const now = Timestamp.now();
    let queued = 0;
    let skipped = 0;
    for (const doc of active.docs) {
      const uid = doc.ref.parent.parent!.id;
      const endsAt = doc.get("endsAt") as Timestamp | null;
      if (endsAt && endsAt.toMillis() < now.toMillis()) {
        await doc.ref.update({ status: "ended", runState: "idle" });
        continue;
      }
      const nextRunAt = doc.get("nextRunAt") as Timestamp | null | undefined;
      if (nextRunAt && nextRunAt.toMillis() > now.toMillis()) continue; // not due yet

      // Nobody is reading: when offers from this search pile up unreviewed, pause it rather than pay for
      // more. It resumes by itself the morning after the student has gone through them.
      const perRun = Math.max(Number(doc.get("maxPerRun")) || 5, 1);
      const waiting = await db
        .collection(`users/${uid}/applications`)
        .where("searchId", "==", doc.id)
        .where("status", "==", "suggested")
        .count()
        .get()
        .then((r) => r.data().count)
        .catch((e) => {
          logger.warn("Couldn't count waiting offers; running the search anyway", { uid, searchId: doc.id, error: String(e) });
          return 0;
        });
      if (waiting >= Math.max(BACKLOG_RUNS * perRun, 10)) {
        await doc.ref.update({ waitingForReview: waiting });
        skipped++;
        continue;
      }
      await doc.ref.update({ runState: "queued", waitingForReview: FieldValue.delete() });
      await queue().enqueue({ uid, searchId: doc.id });
      queued++;
    }
    logger.info("Morning searches", { active: active.size, queued, pausedForReview: skipped });
  },
);

/** Runs a search immediately (e.g. right after the user creates it). */
export const runSearchNow = onCall({ region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  const searchId = z.string().min(1).parse(request.data?.searchId);
  const ref = db.doc(`users/${uid}/searches/${searchId}`);
  const search = (await ref.get()).data() as Search | undefined;
  if (!search) throw new HttpsError("not-found", "Search not found.");
  if (search.status !== "active") throw new HttpsError("failed-precondition", "Resume this search first.");
  if (search.runState === "queued" || search.runState === "running") return { queued: false };
  await ref.update({ runState: "queued" });
  await queue().enqueue({ uid, searchId });
  return { queued: true };
});
