import { createHmac, timingSafeEqual } from "node:crypto";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { defineSecret } from "firebase-functions/params";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import { z } from "zod";
import { GMAIL_SECRETS } from "./gmail.js";
import { APP_URL, emailUser, longDate } from "./notify.js";
import { db, entitlementFor, type Plan, REGION } from "./shared.js";

// Payments with Stripe (plain REST, no SDK). The three contracts are Stripe prices found by lookup key;
// Stripe's webhook keeps private/{uid}.plan up to date, which is what grants access (see entitlementFor).

export const stripeKey = defineSecret("STRIPE_SECRET_KEY");
const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");

const LOOKUP_KEYS = { monthly: "baptou_monthly", annual: "baptou_annual", pass: "baptou_pass" } as const;
type PlanId = keyof typeof LOOKUP_KEYS;
const COMMITMENT_MONTHS = 12; // the yearly plan is paid monthly but committed for 12 months
const RETURN_ORIGINS = ["https://baptou-app.web.app", "http://localhost:3000"];

/** Stripe's form encoding: { a: { b: 1 }, c: [{ d: 2 }] } -> a[b]=1&c[0][d]=2 */
function encode(obj: Record<string, unknown>, prefix = ""): [string, string][] {
  return Object.entries(obj).flatMap(([k, v]) => {
    if (v === undefined || v === null) return [];
    const key = prefix ? `${prefix}[${k}]` : k;
    return typeof v === "object" ? encode(v as Record<string, unknown>, key) : [[key, String(v)]];
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function stripe<T = any>(method: "GET" | "POST" | "DELETE", path: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: { Authorization: `Bearer ${stripeKey.value()}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: body ? new URLSearchParams(encode(body)) : undefined,
  });
  const json = await res.json();
  if (!res.ok) {
    logger.error("Stripe error", { path, status: res.status, message: json.error?.message });
    throw new HttpsError("unavailable", "The payment service didn't respond. Try again.");
  }
  return json as T;
}

const addMonths = (ms: number, months: number) => {
  const d = new Date(ms);
  d.setMonth(d.getMonth() + months);
  return d.getTime();
};

/** The Stripe customer for this user, created on first checkout. */
async function customerFor(uid: string) {
  const ref = db.doc(`private/${uid}`);
  const existing = (await ref.get()).get("stripeCustomerId") as string | undefined;
  if (existing) return existing;
  const user = await getAuth().getUser(uid);
  const customer = await stripe("POST", "customers", { email: user.email, name: user.displayName, metadata: { uid } });
  await ref.set({ stripeCustomerId: customer.id }, { merge: true });
  await db.doc(`stripeCustomers/${customer.id}`).set({ uid });
  return customer.id as string;
}

/** Starts Stripe Checkout for one of the three contracts; returns the page to send the user to. */
export const createCheckout = onCall({ region: REGION, secrets: [stripeKey] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  const { plan, returnTo } = z
    .object({ plan: z.enum(["monthly", "annual", "pass"]), returnTo: z.string().default("") })
    .parse(request.data);

  const current = await entitlementFor(uid);
  if (current && current.kind !== "gift") {
    throw new HttpsError("failed-precondition", "You already have an active plan. You can manage it on this page.");
  }

  const price = (await stripe("GET", `prices?active=true&lookup_keys[]=${LOOKUP_KEYS[plan as PlanId]}`)).data?.[0];
  if (!price) throw new HttpsError("unavailable", "This plan isn't available right now.");
  const origin = RETURN_ORIGINS.includes(returnTo) ? returnTo : RETURN_ORIGINS[0];
  const metadata = { uid, plan };

  const session = await stripe("POST", "checkout/sessions", {
    mode: plan === "pass" ? "payment" : "subscription",
    customer: await customerFor(uid),
    client_reference_id: uid,
    line_items: [{ price: price.id, quantity: 1 }],
    success_url: `${origin}/plans?checkout=success`,
    cancel_url: `${origin}/plans?checkout=cancelled`,
    allow_promotion_codes: true,
    metadata,
    ...(plan === "pass" ? { payment_intent_data: { metadata } } : { subscription_data: { metadata } }),
  });
  return { url: session.url as string };
});

/**
 * Stripe's customer portal, for the payment method and invoices. Cancelling goes through cancelSubscription
 * (end date by email, yearly commitment respected), so the portal is opened without the cancel option.
 */
export const billingPortal = onCall({ region: REGION, secrets: [stripeKey] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  const returnTo = z.string().default("").parse(request.data?.returnTo);
  const priv = await db.doc(`private/${uid}`).get();
  const customer = priv.get("stripeCustomerId") as string | undefined;
  if (!customer) throw new HttpsError("failed-precondition", "You don't have a paid plan yet.");

  const configuration = await portalConfiguration(false);
  const origin = RETURN_ORIGINS.includes(returnTo) ? returnTo : RETURN_ORIGINS[0];
  const session = await stripe("POST", "billing_portal/sessions", {
    customer,
    configuration,
    return_url: `${origin}/plans`,
  });
  return { url: session.url as string };
});

/** Two portal configurations (with and without cancellation), created once and remembered. */
async function portalConfiguration(canCancel: boolean) {
  const ref = db.doc("config/stripe");
  const field = canCancel ? "portalWithCancel" : "portalNoCancel";
  const existing = (await ref.get()).get(field) as string | undefined;
  if (existing) return existing;
  const config = await stripe("POST", "billing_portal/configurations", {
    business_profile: { headline: "BAPTOU" },
    features: {
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      customer_update: { enabled: true, allowed_updates: ["email", "address"] },
      subscription_cancel: canCancel ? { enabled: true, mode: "at_period_end" } : { enabled: false },
    },
  });
  await ref.set({ [field]: config.id }, { merge: true });
  return config.id as string;
}

/**
 * Cancelling from the Plans page, in a few clicks as French law requires. Monthly: ends at the end of the
 * paid month. Yearly: ends when the 12-month commitment does (or at the end of the month once it's over).
 * `undo` keeps the subscription. The user gets the end date by email.
 */
export const cancelSubscription = onCall({ region: REGION, secrets: [stripeKey, ...GMAIL_SECRETS] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  const undo = request.data?.undo === true;
  const plan = (await db.doc(`private/${uid}`).get()).get("plan") as Plan | undefined;
  if (!plan?.subscriptionId || (plan.status !== "active" && plan.status !== "past_due")) {
    throw new HttpsError("failed-precondition", "You don't have an active subscription.");
  }
  const path = `subscriptions/${plan.subscriptionId}`;
  const committedUntil = plan.type === "annual" ? (plan.commitmentEnd?.toMillis() ?? 0) : 0;
  const committed = committedUntil > Date.now();
  let body: Record<string, unknown>;
  if (undo) {
    // Stripe accepts only one of the two at a time.
    const current = await stripe("GET", path);
    body = current.cancel_at_period_end ? { cancel_at_period_end: false } : { cancel_at: "" };
  } else if (committed) {
    body = { cancel_at: Math.floor(committedUntil / 1000), proration_behavior: "none" };
  } else {
    body = { cancel_at_period_end: true };
  }
  const sub = await stripe("POST", path, body);
  await syncSubscription(sub);

  const endsAt = sub.cancel_at ? (sub.cancel_at as number) * 1000 : null;
  if (!undo && endsAt) {
    await emailUser(uid, (lang) =>
      lang === "fr"
        ? {
            subject: `Votre abonnement BAPTOU se termine le ${longDate(endsAt, lang)}`,
            body: `Bonjour,

Nous avons bien reçu la résiliation de votre abonnement BAPTOU ${plan.type === "annual" ? "annuel" : "mensuel"}, le ${longDate(Date.now(), lang)}.

Il se termine le ${longDate(endsAt, lang)}. Vous gardez un accès complet jusque-là${
              committed
                ? ". Votre formule annuelle comporte un engagement de 12 mois : les mensualités jusqu'à cette date restent dues, et il n'y en a plus après."
                : ", sans autre paiement."
            }

Vous avez changé d'avis ? Gardez votre abonnement depuis la page Formules : ${APP_URL}/plans

BAPTOU`,
          }
        : {
            subject: `Your BAPTOU subscription ends on ${longDate(endsAt, lang)}`,
            body: `Hi,

We've received the cancellation of your ${plan.type === "annual" ? "yearly" : "monthly"} BAPTOU subscription, on ${longDate(Date.now(), lang)}.

It ends on ${longDate(endsAt, lang)}. You keep full access until then${
              committed
                ? ". Your yearly plan is committed for 12 months, so the monthly payments until that date are still due; there is none after it."
                : ", and there will be no further payment."
            }

Changed your mind? Keep your subscription from the Plans page: ${APP_URL}/plans

BAPTOU`,
          },
    );
  }
  return { endsAt };
});

// --- Webhook

/** Checks Stripe's signature (HMAC-SHA256 of "timestamp.payload"), within 5 minutes. */
function verifySignature(payload: Buffer, header: string, secret: string) {
  const parts = header.split(",");
  const t = parts.find((p) => p.startsWith("t="))?.slice(2);
  const signatures = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || !signatures.length || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${payload.toString("utf8")}`).digest("hex");
  return signatures.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

async function uidForCustomer(customerId: string) {
  return (await db.doc(`stripeCustomers/${customerId}`).get()).get("uid") as string | undefined;
}

async function setPlan(uid: string, plan: Plan & { subscriptionId?: string }) {
  // A deleted account stays deleted (Stripe sends the cancellation event after the deletion).
  if (!(await getAuth().getUser(uid).catch(() => null))) return logger.info("Plan event for a deleted account", { uid });
  // Replace the whole plan, so fields from an older plan don't linger.
  await db.doc(`private/${uid}`).set({ plan, planUpdatedAt: FieldValue.serverTimestamp() }, { mergeFields: ["plan", "planUpdatedAt"] });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function syncSubscription(sub: any) {
  const uid = (sub.metadata?.uid as string | undefined) ?? (await uidForCustomer(sub.customer));
  if (!uid) return logger.warn("Subscription without a known user", { subscription: sub.id });
  const type = sub.metadata?.plan === "annual" ? "annual" : "monthly";
  // Newer Stripe API versions keep the period on the subscription items.
  const periodEnd = (sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end) as number | undefined;
  const status: Plan["status"] = ["active", "trialing"].includes(sub.status)
    ? "active"
    : ["past_due", "unpaid"].includes(sub.status)
      ? "past_due"
      : sub.status === "canceled"
        ? "canceled"
        : "expired"; // incomplete, incomplete_expired, paused
  await setPlan(uid, {
    type,
    status,
    ...(periodEnd ? { currentPeriodEnd: Timestamp.fromMillis(periodEnd * 1000) } : {}),
    cancelAtPeriodEnd: !!sub.cancel_at_period_end || !!sub.cancel_at,
    ...(sub.cancel_at ? { cancelAt: Timestamp.fromMillis(sub.cancel_at * 1000) } : {}),
    subscriptionId: sub.id,
    ...(type === "annual" && sub.start_date
      ? { commitmentEnd: Timestamp.fromMillis(addMonths(sub.start_date * 1000, COMMITMENT_MONTHS)) }
      : {}),
  });
}

export const stripeWebhook = onRequest({ region: REGION, secrets: [stripeKey, stripeWebhookSecret] }, async (req, res) => {
  if (req.method !== "POST" || !verifySignature(req.rawBody, req.get("stripe-signature") ?? "", stripeWebhookSecret.value())) {
    res.status(400).send("Invalid signature");
    return;
  }
  const event = JSON.parse(req.rawBody.toString("utf8"));
  // Stripe may deliver an event more than once.
  const seen = db.doc(`stripeEvents/${event.id}`);
  if ((await seen.get()).exists) {
    res.send("ok");
    return;
  }
  try {
    const obj = event.data.object;
    switch (event.type) {
      case "checkout.session.completed": {
        const uid = (obj.client_reference_id as string | undefined) ?? obj.metadata?.uid;
        if (obj.mode === "payment" && obj.payment_status === "paid" && uid) {
          // One-month pass: one month from now, no renewal.
          await setPlan(uid, { type: "pass", status: "active", currentPeriodEnd: Timestamp.fromMillis(addMonths(Date.now(), 1)) });
        } else if (obj.mode === "subscription" && obj.subscription) {
          await syncSubscription(await stripe("GET", `subscriptions/${obj.subscription}`));
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await syncSubscription(obj);
        break;
    }
    await seen.set({ type: event.type, at: FieldValue.serverTimestamp() });
    res.send("ok");
  } catch (e) {
    logger.error("Stripe webhook failed", { type: event.type, error: String(e) });
    res.status(500).send("error"); // Stripe retries
  }
});

/**
 * Account deletion: stops the subscription right away (no further payments) and forgets the customer
 * mapping. The Stripe customer and its invoices stay in Stripe (accounting records must be kept).
 */
export async function endBillingForDeletedAccount(uid: string, priv: FirebaseFirestore.DocumentSnapshot) {
  const subscriptionId = priv.get("plan.subscriptionId") as string | undefined;
  const status = priv.get("plan.status") as Plan["status"] | undefined;
  if (subscriptionId && (status === "active" || status === "past_due")) {
    await stripe("DELETE", `subscriptions/${subscriptionId}`);
  }
  const customerId = priv.get("stripeCustomerId") as string | undefined;
  if (customerId) await db.doc(`stripeCustomers/${customerId}`).delete();
}
