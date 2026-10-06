import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { db, entitlementFor, PLAN_BUDGET_USD, REGION } from "./shared.js";

// Reading Gmail needs a restricted Google permission. Until Google's paid security audit is done, Google
// allows it for 100 users over the app's lifetime, so the first 100 users who connect get it; the others
// can still send emails they approve (gmail.send only).
export const GMAIL_READ_CAP = 100;
const gmailSlots = () => db.doc("config/gmailRead");

/** Whether this user has, or can still get, one of the Gmail-reading places. */
export async function gmailReadAvailable(uid: string) {
  const [priv, slots] = await Promise.all([db.doc(`private/${uid}`).get(), gmailSlots().get()]);
  if (priv.get("gmailRead") === true) return true;
  return ((slots.get("granted") as number | undefined) ?? 0) < GMAIL_READ_CAP;
}

/** Takes a place for this user once they actually granted read access (no-op if they already have one). */
export async function claimGmailRead(uid: string) {
  await db.runTransaction(async (tx) => {
    const privRef = db.doc(`private/${uid}`);
    const [priv, slots] = await Promise.all([tx.get(privRef), tx.get(gmailSlots())]);
    if (priv.get("gmailRead") === true) return;
    tx.set(gmailSlots(), { granted: FieldValue.increment(1) }, { merge: true });
    tx.set(privRef, { gmailRead: true }, { merge: true });
    void slots;
  });
}

/** What the app shows on the Plans page and the usage meter. */
export const myPlan = onCall({ region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  const [entitlement, gmailRead] = await Promise.all([entitlementFor(uid), gmailReadAvailable(uid)]);
  return {
    entitlement,
    gmailRead,
    budgetUsd: entitlement?.budgetUsd ?? PLAN_BUDGET_USD,
  };
});
