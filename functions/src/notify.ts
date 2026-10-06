import { getAuth } from "firebase-admin/auth";
import { logger } from "firebase-functions/v2";
import { type Gmail, gmailFor, sendMail } from "./gmail.js";
import { db } from "./shared.js";

// Emails BAPTOU sends to users (invitations, new offers). They go out from the owner's Gmail for now;
// before a large launch this should move to a transactional email service with BAPTOU's own domain.

export const APP_URL = "https://baptou-app.web.app";
export const IDEAL_SCORE = 90; // offers at or above this match score get their own email

/** The owner's Gmail (config/app.ownerUid), used as BAPTOU's sender. */
export async function ownerMailer(): Promise<{ gmail: Gmail; name: string }> {
  const ownerUid = (await db.doc("config/app").get()).get("ownerUid") as string | undefined;
  if (!ownerUid) throw new Error("config/app.ownerUid is not set");
  const owner = await db.doc(`users/${ownerUid}`).get();
  return { gmail: await gmailFor(ownerUid), name: (owner.get("displayName") as string | undefined) ?? "BAPTOU" };
}

export type NewOffer = {
  id: string;
  title: string;
  organization: string;
  location: string;
  matchScore: number;
  matchReason: string;
  deadline: string; // YYYY-MM-DD or empty
};

const bullets = (text: string, max = 4) =>
  text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-•*]\s*/, "").replace(/\*\*/g, "").trim())
    .filter(Boolean)
    .slice(0, max);

const link = (id: string) => `${APP_URL}/applications/view?id=${id}`;
const tab = (searchId: string) => `${APP_URL}/applications?search=${searchId}`;
export const longDate = (ms: number) =>
  new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris" });
const day = (iso: string) => {
  const ms = new Date(`${iso}T12:00:00Z`).getTime();
  return Number.isNaN(ms) ? iso : longDate(ms);
};
const settings = `You receive these emails because "Email me about new offers" is on. Turn it off on your Profile page: ${APP_URL}/profile`;

export function idealEmail(o: NewOffer, searchId: string, searchName: string, others: number) {
  return {
    subject: `⭐ An almost ideal offer: ${o.title} at ${o.organization}`,
    body: `Hi,

Your search "${searchName}" just found an offer that matches you at ${o.matchScore}%:

${o.title}
${o.organization}${o.location ? ` · ${o.location}` : ""}${o.deadline ? `\nDeadline: ${day(o.deadline)}` : ""}

Why it fits you:
${bullets(o.matchReason).map((b) => `- ${b}`).join("\n")}

Open it in BAPTOU, prepare the application and write the letter:
${link(o.id)}
${others > 0 ? `\nThis search also found ${others} other new offer${others > 1 ? "s" : ""}: ${tab(searchId)}\n` : ""}
BAPTOU

${settings}`,
  };
}

export function digestEmail(offers: NewOffer[], searchId: string, searchName: string) {
  const n = offers.length;
  return {
    subject: `${n} new offer${n > 1 ? "s" : ""} for "${searchName}"`,
    body: `Hi,

Your search "${searchName}" found ${n} new offer${n > 1 ? "s" : ""}:

${offers
  .map((o) => `${o.title} · ${o.organization} (${o.matchScore}% match)\n${bullets(o.matchReason, 1).map((b) => `  ${b}`).join("")}\n  ${link(o.id)}`)
  .join("\n\n")}

Review them in BAPTOU: ${tab(searchId)}

BAPTOU

${settings}`,
  };
}

/** Emails the user at their sign-in address, from BAPTOU. Never throws: a failed email must not fail the action. */
export async function emailUser(uid: string, mail: { subject: string; body: string }) {
  try {
    const to = (await getAuth().getUser(uid)).email;
    if (!to) return false;
    const { gmail } = await ownerMailer();
    await sendMail(gmail, { to, fromName: "BAPTOU", ...mail });
    return true;
  } catch (e) {
    logger.error("Email to user failed", { uid, subject: mail.subject, error: String(e) });
    return false;
  }
}

/**
 * Tells the user about a search run's new offers: a dedicated email for each almost ideal offer (up to 2),
 * otherwise one summary email.
 */
export async function notifyNewOffers(uid: string, searchId: string, searchName: string, offers: NewOffer[]) {
  if (!offers.length) return;
  try {
    if ((await db.doc(`users/${uid}`).get()).get("notifyOffers") === false) return;
  } catch {
    return;
  }
  searchName ||= "your search";
  const sorted = [...offers].sort((a, b) => b.matchScore - a.matchScore);
  const ideal = sorted.filter((o) => o.matchScore >= IDEAL_SCORE).slice(0, 2);
  if (ideal.length) {
    for (const o of ideal) await emailUser(uid, idealEmail(o, searchId, searchName, offers.length - ideal.length));
  } else {
    await emailUser(uid, digestEmail(sorted, searchId, searchName));
  }
}
