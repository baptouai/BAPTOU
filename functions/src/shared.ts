import Anthropic from "@anthropic-ai/sdk";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";

initializeApp();

// BAPTOU uses the named Firestore database "baptou", not "(default)".
export const db = getFirestore("baptou");
// Resolved lazily: the bucket name comes from FIREBASE_CONFIG, which is only set at runtime.
export const bucket = () => getStorage().bucket();

export const REGION = "europe-west1";

export type Model = "claude-opus-5" | "claude-sonnet-5" | "claude-haiku-4-5";

// What a Claude call was for, so spending can be shown per task.
export type Task = "search" | "letter" | "form" | "contacts" | "ask" | "email" | "profile";

// Which model each task uses. Writing quality matters most for letters; the rest is research and extraction.
// Chosen to give the best quality within a $10/month budget: the daily search (~30 runs/month) is the
// largest recurring cost, so research tasks use Sonnet 5 and Opus 5 is kept for the letter and profile.
export const MODELS = {
  profile: "claude-opus-5",
  search: "claude-sonnet-5",
  form: "claude-sonnet-5",
  letter: "claude-opus-5",
  email: "claude-sonnet-5",
  ask: "claude-sonnet-5",
  contacts: "claude-sonnet-5",
} satisfies Record<string, Model>;

// USD per million tokens (Claude API list prices). Cache writes cost 1.25x input, cache reads 0.1x.
const PRICES: Record<Model, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
const WEB_SEARCH_USD = 0.01; // $10 per 1,000 searches

// Default monthly Claude budget per user, in USD. Override per user with `monthlyLimitUsd` on private/{uid}.
export const DEFAULT_MONTHLY_LIMIT_USD = 5;

// Stored in Google Secret Manager: `npx firebase functions:secrets:set ANTHROPIC_API_KEY`
export const anthropicKey = defineSecret("ANTHROPIC_API_KEY");

export function claude() {
  return new Anthropic({ apiKey: anthropicKey.value() });
}

// Server-side refusal fallback for Opus 5: if it declines, the API re-runs on a fallback model.
// Not sent for other models.
export const fallbackFor = (model: Model): { betas?: Anthropic.Beta.AnthropicBeta[]; fallbacks?: "default" } =>
  model === "claude-opus-5" ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {};

type Usage = Pick<
  Anthropic.Beta.BetaUsage,
  "input_tokens" | "output_tokens" | "cache_creation_input_tokens" | "cache_read_input_tokens" | "server_tool_use"
>;

export function estimateCostUsd(model: Model, usage: Usage) {
  const p = PRICES[model];
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const searches = usage.server_tool_use?.web_search_requests ?? 0;
  return (
    (usage.input_tokens * p.input + cacheWrite * p.input * 1.25 + cacheRead * p.input * 0.1 + usage.output_tokens * p.output) /
      1_000_000 +
    searches * WEB_SEARCH_USD
  );
}

const month = () => new Date().toISOString().slice(0, 7); // "2026-10"

/**
 * Monthly budget for a user, or null if they have no access. BAPTOU is invite-only: a user needs either
 * an entry in access/{email} (added by the owner) or a personal `monthlyLimitUsd` on private/{uid}.
 */
async function limitFor(uid: string, priv: FirebaseFirestore.DocumentSnapshot): Promise<number | null> {
  const personal = priv.get("monthlyLimitUsd") as number | undefined;
  if (personal != null) return personal;
  const email = (await getAuth().getUser(uid)).email?.toLowerCase();
  if (!email) return null;
  const invite = await db.doc(`access/${email}`).get();
  if (!invite.exists) return null;
  return (invite.get("monthlyLimitUsd") as number | undefined) ?? DEFAULT_MONTHLY_LIMIT_USD;
}

/** Refuses the call when the user isn't invited or has used up this month's budget. Call before every Claude request. */
export async function assertBudget(uid: string) {
  const snap = await db.doc(`private/${uid}`).get();
  const limit = await limitFor(uid, snap);
  if (limit == null) {
    throw new HttpsError(
      "permission-denied",
      "BAPTOU is invite-only for now. Ask the person who shared it with you to add your email address.",
    );
  }
  const spent = (snap.get(`spendUsd.${month()}`) as number | undefined) ?? 0;
  if (spent >= limit) {
    throw new HttpsError(
      "resource-exhausted",
      `You've reached this month's BAPTOU limit ($${limit}). It resets on the 1st of next month.`,
    );
  }
}

/**
 * Records token usage and estimated cost per user and month. The details live in the server-only
 * private/{uid} doc; a summary is mirrored on users/{uid} so the app can show it.
 */
export async function recordUsage(uid: string, model: Model, usage: Usage, task: Task) {
  const cost = estimateCostUsd(model, usage);
  const m = month();
  await db.doc(`private/${uid}`).set(
    {
      usage: {
        inputTokens: FieldValue.increment(usage.input_tokens),
        outputTokens: FieldValue.increment(usage.output_tokens),
        cacheWriteTokens: FieldValue.increment(usage.cache_creation_input_tokens ?? 0),
        cacheReadTokens: FieldValue.increment(usage.cache_read_input_tokens ?? 0),
        webSearches: FieldValue.increment(usage.server_tool_use?.web_search_requests ?? 0),
        calls: FieldValue.increment(1),
      },
      spendUsd: { [m]: FieldValue.increment(cost) },
      spendByTask: { [m]: { [task]: FieldValue.increment(cost) } },
      lastCallAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  const priv = await db.doc(`private/${uid}`).get();
  await db.doc(`users/${uid}`).set(
    {
      usageSummary: {
        month: m,
        spentUsd: priv.get(`spendUsd.${m}`) ?? cost,
        byTask: priv.get(`spendByTask.${m}`) ?? {},
        limitUsd: (await limitFor(uid, priv)) ?? 0,
      },
    },
    { merge: true },
  );
  return cost;
}
