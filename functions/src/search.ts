import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getFunctions } from "firebase-admin/functions";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onTaskDispatched } from "firebase-functions/v2/tasks";
import { z } from "zod";
import { loadProfile, runAgent, today } from "./agent.js";
import { loadDismissed, offerKey, urlId } from "./offers.js";
import { anthropicKey, db, MODELS, REGION } from "./shared.js";

// users/{uid}/searches/{searchId}, created by the user in the app. BAPTOU never searches without one.
type Search = {
  kind?: "internship" | "masters"; // missing on searches created before master's searches existed
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
      matchReason: z.string().describe("2-3 sentences: why this fits the student, citing their profile"),
      companyBrief: z.string().describe("3-5 short lines on the company: what it does, size, recent news, culture"),
    }),
  ),
  summary: z.string().describe("One or two sentences on this search run, for the student"),
});

const SYSTEM = `You are BAPTOU's internship scout. You search the web for real, currently open internship postings that fit a student's profile and search criteria.

Rules:
- Only return postings you actually found during this run (in search results or pages you opened). Never invent a posting, company or link. Open a page when you need to check that a posting is still open.
- Prefer the company's own careers page or the original job-board posting. The url must lead to that specific posting.
- Skip postings that are closed, expired, or whose deadline has passed.
- Respect the search criteria (roles, locations, work mode, duration, start date, languages). Mention any compromise in matchReason.
- Quality over quantity: return fewer offers rather than weak matches. Rank by matchScore, highest first.
- Skip any posting in the "already suggested" or "turned down" lists, and anything very similar to what the student turned down.
- If you run out of searches, return the good offers you found so far rather than nothing.
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
      matchReason: z.string().describe("2-3 sentences: why this programme fits the student's degree, grades and goals"),
      companyBrief: z
        .string()
        .describe("4-6 short lines: tuition per year for this student, admission requirements (degree, grades, tests such as GRE/IELTS), reputation, career outcomes"),
    }),
  ),
  summary: z.string().describe("One or two sentences on this search run, for the student"),
});

const MASTERS_SYSTEM = `You are BAPTOU's admissions scout. You search the web for master's programmes that fit a student who already holds a bachelor's degree, for programmes they apply to directly on the university's website.

Rules:
- Only return programmes you actually found during this run, with their official university page. Never invent a programme, university or link.
- The url must be the programme's own page or its application page on the university's website (not a ranking or aggregator site).
- The application window for the requested intake must still be open, or open later. Skip programmes whose deadline has passed.
- Respect the criteria (fields, countries, intake, teaching language, tuition budget). Check the student's degree and grades against the admission requirements and say so in matchReason; mention any compromise.
- Give real figures in the brief when the university publishes them (tuition for the student's situation, requirements, deadlines).
- Quality over quantity: return fewer programmes rather than weak matches. Rank by matchScore, highest first.
- Skip anything in the "already suggested" or "turned down" lists, and anything very similar to what the student turned down.
- If you run out of searches, return the good programmes you found so far rather than nothing.
When you are done, call submit_offers exactly once.`;

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

    const result = await runAgent({
      uid,
      system: kind === "masters" ? MASTERS_SYSTEM : SYSTEM,
      model: MODELS.search,
      task: "search",
      // Searches are cheap ($0.01); reading pages is what costs, and pages are size-capped in runAgent.
      web: { searches: Math.min(8 + maxPerRun, 40), fetches: Math.min(3 + maxPerRun, 25) },
      maxRunUsd: 0.5 + 0.08 * maxPerRun,
      submit:
        kind === "masters"
          ? { name: "submit_offers", description: "Return the master's programmes found in this run.", schema: ProgrammesSchema }
          : { name: "submit_offers", description: "Return the internship offers found in this run.", schema: OffersSchema },
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
    : `Search criteria:
- Roles / keywords: ${search.roles}
- Locations: ${search.locations || "any"}
- Work mode: ${search.workMode}
- Duration: ${search.duration || "any"}
- Start date: ${search.startDate || "any"}
- Industries: ${search.industries || "any"}
- Languages: ${search.languages || "any"}
- Notes from the student: ${search.notes || "none"}
`
}
${dismissed.reasons.length ? `The student turned down these earlier suggestions. Learn from their reasons and avoid similar offers:\n${dismissed.reasons.join("\n")}\n\n` : ""}Find up to ${maxPerRun} new ${kind === "masters" ? "master's programmes" : "internship offers"}.
Already suggested (skip these): ${seen.length ? seen.slice(0, 150).join("\n") : "none"}
Turned down (never suggest again): ${dismissed.urls.length ? dismissed.urls.slice(0, 150).join("\n") : "none"}`,
        },
      ],
    });

    let created = 0;
    const batchAt = Timestamp.now(); // groups this run's offers into the "Latest batch" list
    for (const o of result.offers) {
      if (created >= maxPerRun) break;
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
