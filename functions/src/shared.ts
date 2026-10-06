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

// What a search looks for, and what kind of opportunity an application is.
export type Kind = "internship" | "job" | "alternance" | "masters";
export const KIND_LABEL: Record<Kind, string> = {
  internship: "Internship",
  job: "Job",
  alternance: "Alternance (French work-study contract)",
  masters: "Master's programme",
};
export const kindLabel = (type: unknown) => KIND_LABEL[(type as Kind) in KIND_LABEL ? (type as Kind) : "internship"];

export type Model = "claude-opus-5" | "claude-sonnet-5" | "claude-haiku-4-5";

// What a Claude call was for, so spending can be shown per task.
export type Task = "search" | "letter" | "form" | "contacts" | "ask" | "email" | "profile" | "replies";

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
  replies: "claude-sonnet-5",
} satisfies Record<string, Model>;

// USD per million tokens (Claude API list prices). Cache writes cost 1.25x input, cache reads 0.1x.
const PRICES: Record<Model, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
const WEB_SEARCH_USD = 0.01; // $10 per 1,000 searches

// AI allowance included in every subscription (and gift): €6 a month. Costs are computed in USD, so the
// allowance is stored in USD (rate kept deliberately round; revisit if EUR/USD moves a lot).
const EUR_TO_USD = 1.1;
export const PLAN_BUDGET_EUR = 6;
export const PLAN_BUDGET_USD = Math.round(PLAN_BUDGET_EUR * EUR_TO_USD * 100) / 100;

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

// What gives a user access to BAPTOU's AI features, most specific first:
// - owner: a personal `monthlyLimitUsd` on private/{uid} (set from BAPTOU Admin);
// - subscription / pass: `plan` on private/{uid}, kept up to date by the Stripe webhook;
// - gift: access/{email} (added from BAPTOU Admin), optionally with an end date.
export type Plan = {
  type: "monthly" | "annual" | "pass";
  status: "active" | "past_due" | "canceled" | "expired";
  currentPeriodEnd?: FirebaseFirestore.Timestamp;
  cancelAtPeriodEnd?: boolean;
  commitmentEnd?: FirebaseFirestore.Timestamp; // annual plan: paid monthly, committed for 12 months
  cancelAt?: FirebaseFirestore.Timestamp; // when a cancelled subscription ends
  subscriptionId?: string;
};

export type Entitlement = {
  kind: "owner" | "monthly" | "annual" | "pass" | "gift";
  budgetUsd: number;
  until: number | null; // ms; null = no end date
  cancelAtPeriodEnd?: boolean;
  endsAt?: number | null; // ms; set once the subscription is cancelled
  commitmentEnd?: number | null; // ms; yearly plan
};

const isLive = (end?: { toMillis(): number } | null) => !end || end.toMillis() > Date.now();

export async function entitlementFor(uid: string, priv?: FirebaseFirestore.DocumentSnapshot): Promise<Entitlement | null> {
  const doc = priv ?? (await db.doc(`private/${uid}`).get());
  const personal = doc.get("monthlyLimitUsd") as number | undefined;
  if (personal != null) return { kind: "owner", budgetUsd: personal, until: null };

  const plan = doc.get("plan") as Plan | undefined;
  if (plan && (plan.status === "active" || plan.status === "past_due") && isLive(plan.currentPeriodEnd)) {
    return {
      kind: plan.type,
      budgetUsd: PLAN_BUDGET_USD,
      until: plan.currentPeriodEnd?.toMillis() ?? null,
      cancelAtPeriodEnd: plan.cancelAtPeriodEnd,
      endsAt: plan.cancelAt?.toMillis() ?? null,
      commitmentEnd: plan.commitmentEnd?.toMillis() ?? null,
    };
  }

  const email = (await getAuth().getUser(uid)).email?.toLowerCase();
  if (!email) return null;
  const gift = await db.doc(`access/${email}`).get();
  if (gift.exists && isLive(gift.get("expiresAt"))) {
    return {
      kind: "gift",
      budgetUsd: (gift.get("monthlyLimitUsd") as number | undefined) ?? PLAN_BUDGET_USD,
      until: (gift.get("expiresAt") as FirebaseFirestore.Timestamp | undefined)?.toMillis() ?? null,
    };
  }
  return null;
}

async function limitFor(uid: string, priv: FirebaseFirestore.DocumentSnapshot): Promise<number | null> {
  return (await entitlementFor(uid, priv))?.budgetUsd ?? null;
}

/** Refuses the call without an active subscription (or gift), or once this month's allowance is used. Call before every Claude request. */
export async function assertBudget(uid: string) {
  const snap = await db.doc(`private/${uid}`).get();
  const limit = await limitFor(uid, snap);
  if (limit == null) {
    throw new HttpsError(
      "permission-denied",
      "You need an active BAPTOU subscription for this. See the Plans page.",
    );
  }
  const spent = (snap.get(`spendUsd.${month()}`) as number | undefined) ?? 0;
  if (spent >= limit) {
    throw new HttpsError(
      "resource-exhausted",
      "You've used 100% of this month's allowance. It renews on the 1st of next month.",
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
