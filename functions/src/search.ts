import { createHash } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getFunctions } from "firebase-admin/functions";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onTaskDispatched } from "firebase-functions/v2/tasks";
import { z } from "zod";
import { loadProfile, runAgent, today } from "./agent.js";
import { anthropicKey, db, REGION } from "./shared.js";

// users/{uid}/searches/{searchId}, created by the user in the app. BAPTOU never searches without one.
type Search = {
  name: string;
  roles: string;
  locations: string;
  workMode: "any" | "onsite" | "hybrid" | "remote";
  duration: string;
  startDate: string;
  industries: string;
  languages: string;
  notes: string;
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
- Only return postings you actually found and opened during this run. Never invent a posting, company or link.
- Prefer the company's own careers page or the original job-board posting. The url must lead to that specific posting.
- Skip postings that are closed, expired, or whose deadline has passed.
- Respect the search criteria (roles, locations, work mode, duration, start date, languages). Mention any compromise in matchReason.
- Quality over quantity: return fewer offers rather than weak matches. Rank by matchScore, highest first.
- Skip any posting whose url is in the "already suggested" list.
When you are done, call submit_offers exactly once.`;

const urlId = (url: string) =>
  createHash("sha1").update(url.trim().toLowerCase().replace(/[#?].*$/, "").replace(/\/$/, "")).digest("hex").slice(0, 20);

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
    const existing = await db
      .collection(`users/${uid}/applications`)
      .where("type", "==", "internship")
      .orderBy("updatedAt", "desc")
      .limit(200)
      .select("applyUrl")
      .get();
    const seen = existing.docs.map((d) => d.get("applyUrl")).filter(Boolean);
    const maxPerRun = Math.min(Math.max(search.maxPerRun || 5, 1), 10);

    const result = await runAgent({
      uid,
      system: SYSTEM,
      maxSearches: 15,
      submit: { name: "submit_offers", description: "Return the internship offers found in this run.", schema: OffersSchema },
      prompt: [
        { type: "text", text: `Student profile:\n${JSON.stringify(profile, null, 2)}` },
        {
          type: "text",
          text: `Today is ${today()}.
Search criteria:
- Roles / keywords: ${search.roles}
- Locations: ${search.locations || "any"}
- Work mode: ${search.workMode}
- Duration: ${search.duration || "any"}
- Start date: ${search.startDate || "any"}
- Industries: ${search.industries || "any"}
- Languages: ${search.languages || "any"}
- Notes from the student: ${search.notes || "none"}

Find up to ${maxPerRun} new internship offers.
Already suggested (skip these): ${seen.length ? seen.join("\n") : "none"}`,
        },
      ],
    });

    let created = 0;
    for (const o of result.offers.slice(0, maxPerRun)) {
      const ref = db.doc(`users/${uid}/applications/${urlId(o.url)}`);
      try {
        await ref.create({
          type: "internship",
          status: "suggested",
          searchId,
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
      } catch {
        // Already exists: same posting suggested before.
      }
    }

    await searchRef.update({
      runState: "idle",
      lastRunAt: FieldValue.serverTimestamp(),
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
