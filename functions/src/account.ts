import { getAuth } from "firebase-admin/auth";
import { type DocumentReference, type DocumentSnapshot, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { endBillingForDeletedAccount, stripeKey } from "./billing.js";
import { GMAIL_SECRETS, revokeGmail } from "./gmail.js";
import { bucket, db, REGION } from "./shared.js";

// The user's rights over their data (GDPR): a copy of everything BAPTOU stores about them, and deletion.

/** Firestore values as plain JSON (dates as ISO strings, references as paths). */
function plain(v: unknown): unknown {
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (v && typeof v === "object" && "path" in v && "firestore" in v) return (v as DocumentReference).path;
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

/** A document with all its subcollections, recursively. */
async function dump(ref: DocumentReference, snap?: DocumentSnapshot): Promise<Record<string, unknown>> {
  const doc = snap ?? (await ref.get());
  const out: Record<string, unknown> = { id: ref.id, ...(plain(doc.data() ?? {}) as object) };
  for (const col of await ref.listCollections()) {
    const docs = await col.get();
    out[col.id] = await Promise.all(docs.docs.map((d) => dump(d.ref, d)));
  }
  return out;
}

export const exportMyData = onCall({ region: REGION, timeoutSeconds: 300, memory: "512MiB" }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  const [user, priv, files] = await Promise.all([
    dump(db.doc(`users/${uid}`)),
    db.doc(`private/${uid}`).get(),
    bucket().getFiles({ prefix: `users/${uid}/` }),
  ]);
  // Account data kept server-side, without the (encrypted) Gmail token.
  const account = plain(priv.data() ?? {}) as Record<string, unknown>;
  if (account.gmail && typeof account.gmail === "object") delete (account.gmail as Record<string, unknown>).refreshToken;
  return {
    exportedAt: new Date().toISOString(),
    about: "Everything BAPTOU stores about you. Your uploaded files are listed under uploadedFiles; download them from your Profile page.",
    user,
    account,
    uploadedFiles: files[0].map((f) => ({ name: f.name.split("/").pop(), size: Number(f.metadata.size), uploadedAt: f.metadata.timeCreated })),
  };
});

export const deleteMyAccount = onCall(
  { region: REGION, timeoutSeconds: 300, secrets: [stripeKey, ...GMAIL_SECRETS] },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
    if (request.data?.confirm !== "DELETE") throw new HttpsError("invalid-argument", "Type DELETE to confirm.");
    if ((await db.doc("config/app").get()).get("ownerUid") === uid) {
      throw new HttpsError("failed-precondition", "The owner account sends BAPTOU's emails and can't be deleted from the app.");
    }

    const priv = await db.doc(`private/${uid}`).get();
    // Order matters: stop payments and Gmail access first, so nothing keeps running for a half-deleted account.
    await endBillingForDeletedAccount(uid, priv);
    await revokeGmail(uid);
    await bucket().deleteFiles({ prefix: `users/${uid}/` });
    await db.recursiveDelete(db.doc(`users/${uid}`));
    await db.recursiveDelete(db.doc(`private/${uid}`));
    await getAuth().deleteUser(uid);
    logger.info("Account deleted", { uid });
    return { ok: true };
  },
);
