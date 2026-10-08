import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";
import { db, REGION, requireAccess } from "./shared.js";

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

// Words that don't tell organizations apart ("Alpine F1 Team" and "Alpine Racing (F1)" are the same).
const NOT_BRAND = new Set([
  "the", "and", "of", "team", "f1", "formula", "racing", "motorsport", "motorsports", "group", "groupe", "ltd", "limited",
  "plc", "inc", "llc", "gmbh", "sa", "sas", "sarl", "ag", "co", "company", "corporation", "corp", "holding", "holdings",
  "international", "uk", "us", "usa", "north", "america", "europe", "france",
]);

/**
 * A looser key than offerKey: the organization's first distinctive word plus the title, so the same
 * offer found on two sites with differently written company names counts once.
 */
export function looseOfferKey(organization: string, title: string) {
  const words = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  const brand = words(organization).find((w) => w.length >= 3 && !NOT_BRAND.has(w)) ?? words(organization).join("");
  return hash(`${brand}|${words(title).join(" ")}`);
}

// users/{uid}/dismissedOffers/{urlId}: what remains of an offer the student turned down. The offer
// itself is deleted; this record keeps it from ever being suggested again and teaches future searches.
export type DismissedOffer = {
  url: string;
  offerKey: string;
  title: string;
  organization: string;
  reason: string;
  dismissedAt: FirebaseFirestore.FieldValue;
  // For improving the searches: where the offer came from and what BAPTOU thought of it.
  type?: string;
  searchId?: string;
  searchName?: string;
  source?: string; // "manual" when the student added it
  location?: string;
  country?: string;
  matchScore?: number;
  matchReason?: string;
  fromJobBoard?: boolean;
  status?: string; // where the student was with it (suggested, interested, editing…)
  suggestedAt?: FirebaseFirestore.Timestamp;
};

/** Loads the student's dismissals: ids to block (by link and by organization + title) and recent reasons. */
export async function loadDismissed(uid: string) {
  const snap = await db.collection(`users/${uid}/dismissedOffers`).orderBy("dismissedAt", "desc").get();
  return {
    urlIds: new Set(snap.docs.map((d) => d.id)),
    offerKeys: new Set(snap.docs.map((d) => d.get("offerKey") as string)),
    looseKeys: new Set(snap.docs.map((d) => looseOfferKey(d.get("organization") ?? "", d.get("title") ?? ""))),
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
  await requireAccess(uid);
  const { applicationId, reason } = z
    .object({ applicationId: z.string().min(1), reason: z.string().max(1000).default("") })
    .parse(request.data);

  const ref = db.doc(`users/${uid}/applications/${applicationId}`);
  const app = (await ref.get()).data();
  if (!app) return { ok: true }; // already gone
  if (app.emailSentAt) throw new HttpsError("failed-precondition", "You already emailed about this offer, so it is kept.");

  const search = app.searchId ? (await db.doc(`users/${uid}/searches/${app.searchId}`).get()).data() : undefined;
  const record: DismissedOffer = {
    url: app.applyUrl ?? "",
    offerKey: offerKey(app.organization ?? "", app.title ?? ""),
    title: app.title ?? "",
    organization: app.organization ?? "",
    reason: reason.trim(),
    dismissedAt: FieldValue.serverTimestamp(),
    // Only the fields that exist (Firestore rejects undefined values).
    ...Object.fromEntries(
      Object.entries({
        type: app.type,
        searchId: app.searchId,
        searchName: search?.name,
        source: app.source,
        location: app.location,
        country: app.country,
        matchScore: app.matchScore,
        matchReason: app.matchReason,
        fromJobBoard: app.fromJobBoard,
        status: app.status,
        suggestedAt: app.createdAt,
      }).filter(([, v]) => v !== undefined && v !== null && v !== ""),
    ),
  };
  await db.doc(`users/${uid}/dismissedOffers/${app.applyUrl ? urlId(app.applyUrl) : applicationId}`).set(record);
  await db.recursiveDelete(ref); // letter versions and the "is this for me?" chat go too
  return { ok: true };
});
