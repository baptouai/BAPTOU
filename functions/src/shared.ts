import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { oidcFederationProvider } from "@anthropic-ai/sdk/lib/credentials/oidc-federation";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { type CallableRequest, HttpsError } from "firebase-functions/v2/https";
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

// AI allowance included in every subscription (and gift): €10 a month. Costs are computed in USD, so the
// allowance is stored in USD (rate kept deliberately round; revisit if EUR/USD moves a lot).
const EUR_TO_USD = 1.1;
export const PLAN_BUDGET_EUR = 10;
export const PLAN_BUDGET_USD = Math.round(PLAN_BUDGET_EUR * EUR_TO_USD * 100) / 100;

// Stored in Google Secret Manager: `npx firebase functions:secrets:set ANTHROPIC_API_KEY`
export const anthropicKey = defineSecret("ANTHROPIC_API_KEY");

// Workload identity federation (no long-lived API key): once the IDs from the Claude Console are set in
// functions/.env, BAPTOU proves its identity with a short-lived Google ID token for its dedicated service
// account (baptou-claude), and Anthropic answers with an access token that expires within the hour.
// Until then, the API key from Secret Manager is used.
const FEDERATION = {
  ruleId: process.env.ANTHROPIC_FEDERATION_RULE_ID,
  organizationId: process.env.ANTHROPIC_ORGANIZATION_ID,
  serviceAccountId: process.env.ANTHROPIC_SERVICE_ACCOUNT_ID,
  workspaceId: process.env.ANTHROPIC_WORKSPACE_ID || undefined,
  googleAccount: process.env.CLAUDE_GOOGLE_SERVICE_ACCOUNT ?? "baptou-claude@baptou-5041c.iam.gserviceaccount.com",
};
export const usesFederation = () => !!(FEDERATION.ruleId && FEDERATION.organizationId);

/** A Google-signed ID token for baptou-claude, minted with the functions' own runtime identity. */
async function googleIdToken() {
  const meta = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
    headers: { "Metadata-Flavor": "Google" },
  });
  const { access_token } = (await meta.json()) as { access_token: string };
  const res = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${FEDERATION.googleAccount}:generateIdToken`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ audience: "https://api.anthropic.com", includeEmail: true }),
    },
  );
  if (!res.ok) throw new Error(`Couldn't get a Google ID token (${res.status})`);
  return ((await res.json()) as { token: string }).token;
}

// One client per instance, so a federated access token is cached and refreshed rather than re-exchanged.
let client: Anthropic | null = null;
export function claude() {
  if (client) return client;
  client = usesFederation()
    ? new Anthropic({
        // An API key in the environment would take precedence over federation, so it is switched off here.
        apiKey: null,
        authToken: null,
        credentials: oidcFederationProvider({
          identityTokenProvider: googleIdToken,
          federationRuleId: FEDERATION.ruleId!,
          organizationId: FEDERATION.organizationId!,
          serviceAccountId: FEDERATION.serviceAccountId,
          workspaceId: FEDERATION.workspaceId,
          baseURL: "https://api.anthropic.com",
          fetch,
        }),
      })
    : new Anthropic({ apiKey: anthropicKey.value() });
  return client;
}

// Server-side refusal fallback for Opus 5: if it declines, the API re-runs on a fallback model.
// Not sent for other models.
export const fallbackFor = (model: Model): { betas?: Anthropic.Beta.AnthropicBeta[]; fallbacks?: "default" } =>
  model === "claude-opus-5" ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {};

type Usage = Pick<
  Anthropic.Beta.BetaUsage,
  "input_tokens" | "output_tokens" | "cache_creation_input_tokens" | "cache_read_input_tokens" | "server_tool_use"
>;

/** What a response cost. Batch requests (`batch`) bill every token at half price; web searches keep their fee. */
export function estimateCostUsd(model: Model, usage: Usage, batch = false) {
  const p = PRICES[model];
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const searches = usage.server_tool_use?.web_search_requests ?? 0;
  const tokens =
    (usage.input_tokens * p.input + cacheWrite * p.input * 1.25 + cacheRead * p.input * 0.1 + usage.output_tokens * p.output) / 1_000_000;
  return tokens * (batch ? 0.5 : 1) + searches * WEB_SEARCH_USD;
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

  // A gift goes to an address, so only an account that proved it owns that address gets it.
  const user = await getAuth().getUser(uid);
  const email = user.emailVerified ? user.email?.toLowerCase() : undefined;
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

// Free first search: anyone signed in without a plan may build their profile and run one search, within a
// small AI allowance. private/{uid}.trial = { searchId, startedAt, usedAt, emailKey } (server-only); the run
// that completes sets usedAt, and after that the offers stay readable but nothing new runs without a plan.
// (keep in sync with hasTrial in firestore.rules)
export const TRIAL_BUDGET_USD = 3; // for the account's whole life, not per month
export type Trial = { available: boolean; used: boolean; searchId: string | null };

export function trialFrom(priv: FirebaseFirestore.DocumentSnapshot): Trial {
  const t = priv.get("trial") as { searchId?: string; usedAt?: FirebaseFirestore.Timestamp } | undefined;
  return { available: !t?.usedAt, used: !!t?.usedAt, searchId: t?.searchId ?? null };
}

async function limitFor(uid: string, priv: FirebaseFirestore.DocumentSnapshot): Promise<number | null> {
  const entitlement = await entitlementFor(uid, priv);
  if (entitlement) return entitlement.budgetUsd;
  return trialFrom(priv).available ? TRIAL_BUDGET_USD : null;
}

const NO_ACCESS = "You need an active BAPTOU subscription for this. See the Plans page.";
export const TRIAL_USED = "Your free search is done. Choose a plan to prepare your applications and get new offers every morning.";
export const UNVERIFIED = "Confirm your email address first: open the link BAPTOU sent you.";
const TRIAL_SAME_EMAIL = "A free search was already used with this email address. Choose a plan to continue.";
const TRIAL_DISPOSABLE = "The free search isn't available with a temporary email address. Sign up with your usual address, or choose a plan.";
const TRIAL_FULL = "Today's free searches are all taken. Try again tomorrow, or choose a plan.";

/**
 * The signed-in user's uid. An account made with an email and a password counts only once its address is
 * confirmed (Google accounts always are), so nobody gets what is tied to an address they don't own: gifts, the
 * free search, BAPTOU's emails. `unverified: true` also lets in an unconfirmed account (to delete it).
 */
export function requireUser(request: CallableRequest, opts: { unverified?: boolean } = {}) {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  if (!opts.unverified && request.auth?.token.email_verified !== true) throw new HttpsError("permission-denied", UNVERIFIED);
  return uid;
}

// The free search is one per person, not per account: it is also recorded under the address (hashed, in
// trialEmails/{sha256}), so deleting the account and signing up again with the same address doesn't give a
// second one; the hash is kept after an account is deleted. Temporary-address services are refused, and a daily
// cap (config/app.trialDailyCap) bounds what a wave of new accounts could cost.
const TRIAL_DAILY_CAP = 30;
const DISPOSABLE = new Set([
  "yopmail.com", "yopmail.fr", "yopmail.net", "cool.fr.nf", "jetable.fr.nf", "courriel.fr.nf", "moncourrier.fr.nf",
  "monemail.fr.nf", "monmail.fr.nf", "nospam.ze.tc", "nomail.xl.cx", "mega.zik.dj", "speed.1s.fr", "jetable.org",
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "guerrillamail.org", "guerrillamail.biz",
  "guerrillamail.de", "guerrillamail.info", "guerrillamailblock.com", "sharklasers.com", "grr.la", "pokemail.net",
  "spam4.me", "10minutemail.com", "10minutemail.net", "temp-mail.org", "temp-mail.io", "tempmail.com",
  "tempmail.net", "tempmailo.com", "tempr.email", "discard.email", "trashmail.com", "trashmail.de", "getnada.com",
  "nada.email", "maildrop.cc", "dispostable.com", "mohmal.com", "emailondeck.com", "throwawaymail.com",
  "fakeinbox.com", "mailnesia.com", "mail.tm", "minuteinbox.com", "mytemp.email", "burnermail.io",
  "spamgourmet.com", "inboxkitten.com", "mailcatch.com", "emailfake.com", "crazymailing.com", "tmpmail.org",
  "tmpmail.net", "mail-temp.com", "luxusmail.org", "byom.de",
]);

/** The address as it counts for the free search: lowercase, without a "+tag", and Gmail without dots. */
export function canonicalEmail(email: string) {
  const [local = "", domain = ""] = email.trim().toLowerCase().split("@");
  const d = domain === "googlemail.com" ? "gmail.com" : domain;
  const l = local.split("+")[0];
  return `${d === "gmail.com" ? l.replace(/\./g, "") : l}@${d}`;
}

/** Takes the free search for this account's address, once; throws if the address can't have one. */
async function claimTrial(uid: string, priv: FirebaseFirestore.DocumentSnapshot) {
  if (priv.get("trial.emailKey")) return; // already claimed by this account
  const user = await getAuth().getUser(uid);
  if (!user.email || !user.emailVerified) throw new HttpsError("permission-denied", UNVERIFIED);
  const canonical = canonicalEmail(user.email);
  if (DISPOSABLE.has(canonical.split("@")[1])) throw new HttpsError("permission-denied", TRIAL_DISPOSABLE);
  const key = createHash("sha256").update(canonical).digest("hex");
  const cap = ((await db.doc("config/app").get()).get("trialDailyCap") as number | undefined) ?? TRIAL_DAILY_CAP;
  const markRef = db.doc(`trialEmails/${key}`);
  const dayRef = db.doc(`trialDays/${new Date().toISOString().slice(0, 10)}`);
  const privRef = db.doc(`private/${uid}`);
  const outcome = await db.runTransaction(async (tx) => {
    const [mark, day] = await Promise.all([tx.get(markRef), tx.get(dayRef)]);
    if (mark.exists && mark.get("uid") !== uid) {
      // Recorded as used, so the app and the database rules treat it like any finished free search.
      tx.set(privRef, { trial: { usedAt: FieldValue.serverTimestamp(), emailKey: key, sameEmail: true } }, { merge: true });
      return TRIAL_SAME_EMAIL;
    }
    if (!mark.exists) {
      if (((day.get("started") as number | undefined) ?? 0) >= cap) return TRIAL_FULL;
      tx.set(markRef, { uid, at: FieldValue.serverTimestamp() });
      tx.set(dayRef, { started: FieldValue.increment(1) }, { merge: true });
    }
    tx.set(privRef, { trial: { emailKey: key } }, { merge: true });
    return null;
  });
  if (outcome) throw new HttpsError(outcome === TRIAL_FULL ? "resource-exhausted" : "permission-denied", outcome);
}

/**
 * Refuses the call unless the user has access: a paid subscription, a gift, or the owner's own limit.
 * Every callable that does something calls it; only billing and account functions (plans, checkout,
 * export, deletion, Gmail disconnection) stay open to everyone signed in. `trial: true` also lets in
 * users on their free first search (profile and that search only).
 */
export async function requireAccess(uid: string, opts: { trial?: boolean } = {}) {
  const priv = await db.doc(`private/${uid}`).get();
  if (await entitlementFor(uid, priv)) return;
  if (opts.trial && trialFrom(priv).available) return claimTrial(uid, priv);
  throw new HttpsError("permission-denied", trialFrom(priv).used ? TRIAL_USED : NO_ACCESS);
}

/** Everything this account has ever spent on AI, in USD. */
const lifetimeSpend = (priv: FirebaseFirestore.DocumentSnapshot) =>
  Object.values((priv.get("spendUsd") as Record<string, number> | undefined) ?? {}).reduce((sum, v) => sum + (Number(v) || 0), 0);

/** Refuses the call without an active subscription, gift or free search, or once the allowance is used. Call before every Claude request. */
export async function assertBudget(uid: string) {
  const snap = await db.doc(`private/${uid}`).get();
  const limit = await limitFor(uid, snap);
  if (limit == null) throw new HttpsError("permission-denied", trialFrom(snap).used ? TRIAL_USED : NO_ACCESS);
  if (!(await entitlementFor(uid, snap))) {
    // The free search: its allowance doesn't come back each month. Once spent, the free search is over.
    if (lifetimeSpend(snap) >= TRIAL_BUDGET_USD) {
      await db.doc(`private/${uid}`).set({ trial: { usedAt: FieldValue.serverTimestamp() } }, { merge: true });
      throw new HttpsError("resource-exhausted", TRIAL_USED);
    }
    return;
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
 * At most `max` calls of `name` per user within `windowSec` (recent call times kept on private/{uid}.rate).
 * For the calls that cost BAPTOU money even without AI (headless Chrome, exports, Stripe), so one account
 * can't run up its bills.
 */
export async function rateLimit(uid: string, name: string, max: number, windowSec: number) {
  if (!(await withinRate(uid, name, max, windowSec))) {
    throw new HttpsError("resource-exhausted", "Too many requests. Wait a few minutes and try again.");
  }
}

/** Counts this call and says whether it is within the limit (see rateLimit), for calls that skip rather than fail. */
export async function withinRate(uid: string, name: string, max: number, windowSec: number) {
  const ref = db.doc(`private/${uid}`);
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const times = ((await tx.get(ref)).get(`rate.${name}`) as number[] | undefined) ?? [];
    const recent = times.filter((t) => now - t < windowSec * 1000);
    if (recent.length >= max) return false;
    tx.set(ref, { rate: { [name]: [...recent, now] } }, { merge: true });
    return true;
  });
}

/**
 * Records token usage and estimated cost per user and month. The details live in the server-only
 * private/{uid} doc; a summary is mirrored on users/{uid} so the app can show it.
 */
export async function recordUsage(uid: string, model: Model, usage: Usage, task: Task, batch = false) {
  const cost = estimateCostUsd(model, usage, batch);
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
