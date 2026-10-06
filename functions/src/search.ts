import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getFunctions } from "firebase-admin/functions";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onTaskDispatched } from "firebase-functions/v2/tasks";
import { z } from "zod";
import { loadProfile, runAgent, today } from "./agent.js";
import { loadDismissed, offerKey, urlId } from "./offers.js";
import { checkPostings } from "./postings.js";
import { anthropicKey, db, type Kind, MODELS, REGION } from "./shared.js";

// users/{uid}/searches/{searchId}, created by the user in the app. BAPTOU never searches without one.
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
      matchScore: z.number().describe("0 to 100"),
      matchReason: z.string().describe("2-4 reasons this fits the student, citing their profile. Bullet points: one per line, each starting with '- ', max 12 words each, no paragraphs."),
      companyBrief: z.string().describe("3-5 facts on the company: what it does, size, recent news, culture. Bullet points: one per line, each starting with '- ', max 12 words each, no paragraphs."),
    }),
  ),
  summary: z.string().describe("One short sentence for the student (max 25 words): what this run found"),
  leadsToCheckNext: z
    .array(z.string())
    .describe("Up to 8 promising companies or careers pages you did not have time to check this run, for the next run"),
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
- Only return postings you actually found during this run (in search results or pages you opened). Never invent a posting, company or link. Open a page when you need to check that a posting is still open.
- Prefer the company's own careers page or the original job-board posting. The url must lead to that specific posting.
- Entry-level, junior or graduate roles only, unless the student asks otherwise. Skip internships, alternances and senior roles.
- Respect the criteria (roles, locations, work mode, contract type, minimum salary, start date, languages). Mention any compromise in matchReason.
- Use the student's nationalities (in the profile) for work permits: don't skip postings that require a right to work the student has, and flag visa sponsorship needs in matchReason.
- Quality over quantity: return fewer offers rather than weak matches. Rank by matchScore, highest first.
- Skip any posting in the "already suggested" or "turned down" lists, and anything very similar to what the student turned down.
- Start with the leads the previous run didn't have time to check, if any.
- If you run out of searches, return the good offers you found so far rather than nothing, and list what you didn't have time to check in leadsToCheckNext.
When you are done, call submit_offers exactly once.`;

const ALTERNANCE_SYSTEM = `You are BAPTOU's alternance scout. You search the web for real, currently open alternance offers in France (contrat d'apprentissage or contrat de professionnalisation) that fit a student's profile and search criteria.

Rules:
- Only return offers you actually found during this run (in search results or pages you opened). Never invent an offer, company or link. Open a page when you need to check that an offer is still open.
- Good sources: La bonne alternance, France Travail, HelloWork, Welcome to the Jungle, JobTeaser, Indeed France, and companies' own career pages. The url must lead to that specific offer.
- Alternance offers only (not internships or regular jobs). Most start in September; check the start date and the contract length (usually 1 to 3 years).
- Respect the criteria (roles, locations, contract type, rhythm, start date). Mention any compromise in matchReason.
- The school matters: if the student already has a school, prefer offers compatible with its programme and rhythm; if they still need one, favour offers whose company names a partner school, and say so in matchReason.
- Quality over quantity: return fewer offers rather than weak matches. Rank by matchScore, highest first.
- Skip any offer in the "already suggested" or "turned down" lists, and anything very similar to what the student turned down.
- Start with the leads the previous run didn't have time to check, if any.
- If you run out of searches, return the good offers you found so far rather than nothing, and list what you didn't have time to check in leadsToCheckNext.
When you are done, call submit_offers exactly once.`;

const SYSTEM = `You are BAPTOU's internship scout. You search the web for real, currently open internship postings that fit a student's profile and search criteria.

Rules:
- Only return postings you actually found during this run (in search results or pages you opened). Never invent a posting, company or link. Open a page when you need to check that a posting is still open.
- Prefer the company's own careers page or the original job-board posting. The url must lead to that specific posting.
- Skip postings that are closed, expired, or whose deadline has passed.
- Respect the search criteria (roles, locations, work mode, duration, start date, languages). Mention any compromise in matchReason.
- Use the student's nationalities (in the profile) for work permits: don't skip postings that require a right to work the student has, and flag visa sponsorship needs in matchReason.
- Quality over quantity: return fewer offers rather than weak matches. Rank by matchScore, highest first.
- Skip any posting in the "already suggested" or "turned down" lists, and anything very similar to what the student turned down.
- Start with the leads the previous run didn't have time to check, if any.
- If you run out of searches, return the good offers you found so far rather than nothing, and list what you didn't have time to check in leadsToCheckNext.
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
      matchScore: z.number().describe("0 to 100"),
      matchReason: z.string().describe("2-4 reasons this programme fits the student's degree, grades and goals. Bullet points: one per line, each starting with '- ', max 12 words each, no paragraphs."),
      companyBrief: z
        .string()
        .describe("4-6 facts: tuition per year for this student, admission requirements (degree, grades, tests such as GRE/IELTS), reputation, career outcomes. Bullet points: one per line, each starting with '- ', max 12 words each, no paragraphs."),
    }),
  ),
  summary: z.string().describe("One short sentence for the student (max 25 words): what this run found"),
  leadsToCheckNext: z
    .array(z.string())
    .describe("Up to 8 promising companies or careers pages you did not have time to check this run, for the next run"),
});

const MASTERS_SYSTEM = `You are BAPTOU's admissions scout. You search the web for master's programmes that fit a student who already holds a bachelor's degree, for programmes they apply to directly on the university's website.

Rules:
- Only return programmes you actually found during this run, with their official university page. Never invent a programme, university or link.
- The url must be the programme's own page or its application page on the university's website (not a ranking or aggregator site).
- The application window for the requested intake must still be open, or open later. Skip programmes whose deadline has passed.
- Respect the criteria (fields, countries, intake, teaching language, tuition budget). Check the student's degree and grades against the admission requirements and say so in matchReason; mention any compromise.
- Use the student's nationalities (in the profile) for tuition: give the fee that applies to them (home, EU or international) and any visa need.
- Give real figures in the brief when the university publishes them (tuition for the student's situation, requirements, deadlines).
- Quality over quantity: return fewer programmes rather than weak matches. Rank by matchScore, highest first.
- Skip anything in the "already suggested" or "turned down" lists, and anything very similar to what the student turned down.
- Start with the leads the previous run didn't have time to check, if any.
- If you run out of searches, return the good programmes you found so far rather than nothing, and list what you didn't have time to check in leadsToCheckNext.
When you are done, call submit_offers exactly once.`;

/**
 * When the daily job should run this search next: after its normal interval when the run found
 * something, and backing off (2x, 4x… up to a week) after runs that found nothing.
 */
function nextRunAfter(search: Search, created: number) {
  const base = search.frequencyDays ?? 1;
  const emptyStreak = created > 0 ? 0 : (search.emptyStreak ?? 0) + 1;
  const days = Math.min(base * 2 ** emptyStreak, Math.max(7, base));
  // An hour early, so the 07:00 job on that day picks it up.
  const nextRunAt = Timestamp.fromMillis(Date.now() + days * 86_400_000 - 3_600_000);
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
    const existingKeys = new Set(existing.docs.map((d) => offerKey(d.get("organization") ?? "", d.get("title") ?? "")));
    // Turned-down offers are deleted but remembered: never suggested again, and their reasons guide the search.
    const dismissed = await loadDismissed(uid);
    // No product limit on offers per run; 50 only guards against typos (e.g. 500) and oversized answers.
    const maxPerRun = Math.min(Math.max(Math.round(search.maxPerRun) || 5, 1), 50);

    const stats = { costUsd: 0 };
    const result = await runAgent({
      uid,
      system: { internship: SYSTEM, job: JOB_SYSTEM, alternance: ALTERNANCE_SYSTEM, masters: MASTERS_SYSTEM }[kind],
      model: MODELS.search,
      task: "search",
      // Searches are cheap ($0.01); reading pages is what costs, and pages are size-capped in runAgent.
      web: { searches: Math.min(10 + maxPerRun, 40), fetches: Math.min(5 + maxPerRun, 25) },
      effort: "low",
      maxPageTokens: 4000,
      maxRunUsd: 0.2 + 0.04 * maxPerRun,
      stats,
      submit: {
        name: "submit_offers",
        description: `Return the ${NOUN[kind]} found in this run.`,
        schema: { internship: OffersSchema, job: JobsSchema, alternance: AlternanceSchema, masters: ProgrammesSchema }[kind],
      },
      prompt: [
        { type: "text", text: `Student profile:\n${JSON.stringify(profile, null, 2)}` },
        {
          type: "text",
          text: `Today is ${today()}.
${
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
`
}
${dismissed.reasons.length ? `The student turned down these earlier suggestions. Learn from their reasons and avoid similar offers:\n${dismissed.reasons.join("\n")}\n\n` : ""}${search.nextLeads?.length ? `The previous run didn't have time to check these leads; start with them:\n${search.nextLeads.map((l) => `- ${l}`).join("\n")}\n\n` : ""}Find up to ${maxPerRun} new ${NOUN[kind]}.
Already suggested (skip these): ${seen.length ? seen.slice(0, 150).join("\n") : "none"}
Turned down (never suggest again): ${dismissed.urls.length ? dismissed.urls.slice(0, 150).join("\n") : "none"}`,
        },
      ],
    });

    let created = 0;
    const batchAt = Timestamp.now(); // groups this run's offers into the "Latest batch" list
    // Dead links (removed or expired postings) never reach the student. Plain HTTP check, no AI.
    const links = await checkPostings(result.offers.map((o) => o.url));
    const dropped = result.offers.filter((o) => links.get(o.url)?.status === "closed").length;
    for (const o of result.offers) {
      if (created >= maxPerRun) break;
      if (links.get(o.url)?.status === "closed") continue;
      const id = urlId(o.url);
      const key = offerKey(o.organization, o.title);
      // Hard guarantee, whatever the model returned: turned-down and already-listed offers never come back.
      if (dismissed.urlIds.has(id) || dismissed.offerKeys.has(key) || existingKeys.has(key)) continue;
      const ref = db.doc(`users/${uid}/applications/${id}`);
      try {
        await ref.create({
          type: kind,
          status: "suggested",
          searchId,
          batchAt,
          title: o.title,
          organization: o.organization,
          country: o.country,
          location: o.location,
          applyUrl: o.url,
          deadline: parseDate(o.deadline),
          startDate: o.startDate,
          duration: o.duration,
          postingLanguage: o.postingLanguage,
          matchScore: Math.round(Math.min(Math.max(o.matchScore, 0), 100)),
          matchReason: o.matchReason,
          research: o.companyBrief,
          // Contract details for jobs and alternances (absent on other kinds).
          ...pick(o, ["contractType", "salary", "rhythm", "school"]),
          letter: "",
          packFields: [],
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        created++;
        existingKeys.add(key);
      } catch {
        // Already exists: same posting suggested before.
      }
    }

    await searchRef.update({
      runState: "idle",
      lastRunAt: FieldValue.serverTimestamp(),
      lastBatchAt: batchAt,
      lastRunCreated: created,
      lastRunDropped: dropped, // offers whose posting turned out to be closed
      lastRunCostUsd: Math.round(stats.costUsd * 100) / 100,
      ...nextRunAfter(search, created),
      nextLeads: result.leadsToCheckNext.slice(0, 8),
      lastRunSummary: `${created} new offer${created === 1 ? "" : "s"}. ${result.summary}`,
      totalFound: FieldValue.increment(created),
    });
  } catch (e) {
    logger.error("runSearch failed", { uid, searchId, error: String(e) });
    await searchRef.update({
      runState: "error",
      lastError: e instanceof HttpsError ? e.message : "The search failed. It will try again tomorrow.",
    });
  }
}

const queue = () => getFunctions().taskQueue(`locations/${REGION}/functions/runSearchTask`);

/** One search run, dispatched by Cloud Tasks so many users' searches run in parallel. */
export const runSearchTask = onTaskDispatched<{ uid: string; searchId: string }>(
  {
    region: REGION,
    secrets: [anthropicKey],
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
    for (const doc of active.docs) {
      const uid = doc.ref.parent.parent!.id;
      const endsAt = doc.get("endsAt") as Timestamp | null;
      if (endsAt && endsAt.toMillis() < now.toMillis()) {
        await doc.ref.update({ status: "ended", runState: "idle" });
        continue;
      }
      const nextRunAt = doc.get("nextRunAt") as Timestamp | null | undefined;
      if (nextRunAt && nextRunAt.toMillis() > now.toMillis()) continue; // not due yet
      await doc.ref.update({ runState: "queued" });
      await queue().enqueue({ uid, searchId: doc.id });
    }
    logger.info(`Queued ${active.size} searches`);
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
