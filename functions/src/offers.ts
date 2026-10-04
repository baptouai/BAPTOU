import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";
import { db, REGION } from "./shared.js";

const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 20);

/** Same posting, whatever tracking parameters or trailing slash the link carries. */
export const urlId = (url: string) => hash(url.trim().toLowerCase().replace(/[#?].*$/, "").replace(/\/$/, ""));

/** Same offer reposted under another link: organization + title, ignoring case, accents and punctuation. */
export const offerKey = (organization: string, title: string) =>
  hash(
    `${organization}|${title}`
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9|]+/g, " ")
      .trim(),
  );

// users/{uid}/dismissedOffers/{urlId}: what remains of an offer the student turned down. The offer
// itself is deleted; this record keeps it from ever being suggested again and teaches future searches.
export type DismissedOffer = {
  url: string;
  offerKey: string;
  title: string;
  organization: string;
  reason: string;
  dismissedAt: FirebaseFirestore.FieldValue;
};

/** Loads the student's dismissals: ids to block (by link and by organization + title) and recent reasons. */
export async function loadDismissed(uid: string) {
  const snap = await db.collection(`users/${uid}/dismissedOffers`).orderBy("dismissedAt", "desc").get();
  return {
    urlIds: new Set(snap.docs.map((d) => d.id)),
    offerKeys: new Set(snap.docs.map((d) => d.get("offerKey") as string)),
    urls: snap.docs.map((d) => d.get("url") as string),
    reasons: snap.docs
      .filter((d) => d.get("reason"))
      .slice(0, 20)
      .map((d) => `- ${d.get("title")} at ${d.get("organization")}: ${d.get("reason")}`),
  };
}

/** "Not for me": deletes the offer and everything attached to it, and records it so it never comes back. */
export const dismissOffer = onCall({ region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  const { applicationId, reason } = z
    .object({ applicationId: z.string().min(1), reason: z.string().max(1000).default("") })
    .parse(request.data);

  const ref = db.doc(`users/${uid}/applications/${applicationId}`);
  const app = (await ref.get()).data();
  if (!app) return { ok: true }; // already gone
  if (app.emailSentAt) throw new HttpsError("failed-precondition", "You already emailed about this offer, so it is kept.");

  const record: DismissedOffer = {
    url: app.applyUrl ?? "",
    offerKey: offerKey(app.organization ?? "", app.title ?? ""),
    title: app.title ?? "",
    organization: app.organization ?? "",
    reason: reason.trim(),
    dismissedAt: FieldValue.serverTimestamp(),
  };
  await db.doc(`users/${uid}/dismissedOffers/${app.applyUrl ? urlId(app.applyUrl) : applicationId}`).set(record);
  await db.recursiveDelete(ref); // letter versions and the "is this for me?" chat go too
  return { ok: true };
});
