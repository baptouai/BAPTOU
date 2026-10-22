import { getAuth } from "firebase-admin/auth";
import { logger } from "firebase-functions/v2";
import { senderGmail, sendMail } from "./gmail.js";
import { db } from "./shared.js";

// Emails BAPTOU sends to users (invitations, new offers, cancellations). They go out from BAPTOU's own
// Gmail (baptouai@gmail.com, see senderGmail); before a large launch this should move to a transactional
// email service with BAPTOU's own domain. Each is written in the user's language (users/{uid}.lang).

export const APP_URL = "https://app.baptou.com";
export const IDEAL_SCORE = 90; // offers at or above this match score get their own email

export type Lang = "en" | "fr";
type Mail = { subject: string; body: string };

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
export const longDate = (ms: number, lang: Lang = "en") =>
  new Date(ms).toLocaleDateString(lang === "fr" ? "fr-FR" : "en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Paris",
  });
const day = (iso: string, lang: Lang) => {
  const ms = new Date(`${iso}T12:00:00Z`).getTime();
  return Number.isNaN(ms) ? iso : longDate(ms, lang);
};
const settings = (lang: Lang) =>
  lang === "fr"
    ? `Vous recevez ces emails car « M'envoyer un email pour les nouvelles offres » est activé. Pour le désactiver, allez sur votre page Profil : ${APP_URL}/profile`
    : `You receive these emails because "Email me about new offers" is on. Turn it off on your Profile page: ${APP_URL}/profile`;

export function idealEmail(o: NewOffer, searchId: string, searchName: string, others: number, lang: Lang = "en"): Mail {
  const where = `${o.organization}${o.location ? ` · ${o.location}` : ""}`;
  const reasons = bullets(o.matchReason).map((b) => `- ${b}`).join("\n");
  if (lang === "fr") {
    return {
      subject: `⭐ Une offre presque idéale : ${o.title} chez ${o.organization}`,
      body: `Bonjour,

Votre recherche « ${searchName} » vient de trouver une offre qui vous correspond à ${o.matchScore} % :

${o.title}
${where}${o.deadline ? `\nDate limite : ${day(o.deadline, lang)}` : ""}

Pourquoi elle vous correspond :
${reasons}

Ouvrez-la dans BAPTOU pour préparer la candidature et rédiger la lettre :
${link(o.id)}
${others > 0 ? `\nCette recherche a aussi trouvé ${others} autre${others > 1 ? "s" : ""} nouvelle${others > 1 ? "s" : ""} offre${others > 1 ? "s" : ""} : ${tab(searchId)}\n` : ""}
BAPTOU

${settings(lang)}`,
    };
  }
  return {
    subject: `⭐ An almost ideal offer: ${o.title} at ${o.organization}`,
    body: `Hi,

Your search "${searchName}" just found an offer that matches you at ${o.matchScore}%:

${o.title}
${where}${o.deadline ? `\nDeadline: ${day(o.deadline, lang)}` : ""}

Why it fits you:
${reasons}

Open it in BAPTOU, prepare the application and write the letter:
${link(o.id)}
${others > 0 ? `\nThis search also found ${others} other new offer${others > 1 ? "s" : ""}: ${tab(searchId)}\n` : ""}
BAPTOU

${settings(lang)}`,
  };
}

export function digestEmail(offers: NewOffer[], searchId: string, searchName: string, lang: Lang = "en"): Mail {
  const n = offers.length;
  const list = offers
    .map(
      (o) =>
        `${o.title} · ${o.organization} (${o.matchScore}${lang === "fr" ? " % de correspondance" : "% match"})\n${bullets(o.matchReason, 1)
          .map((b) => `  ${b}`)
          .join("")}\n  ${link(o.id)}`,
    )
    .join("\n\n");
  if (lang === "fr") {
    const offres = `${n} nouvelle${n > 1 ? "s" : ""} offre${n > 1 ? "s" : ""}`;
    return {
      subject: `${offres} pour « ${searchName} »`,
      body: `Bonjour,

Votre recherche « ${searchName} » a trouvé ${offres} :

${list}

Consultez-les dans BAPTOU : ${tab(searchId)}

BAPTOU

${settings(lang)}`,
    };
  }
  return {
    subject: `${n} new offer${n > 1 ? "s" : ""} for "${searchName}"`,
    body: `Hi,

Your search "${searchName}" found ${n} new offer${n > 1 ? "s" : ""}:

${list}

Review them in BAPTOU: ${tab(searchId)}

BAPTOU

${settings(lang)}`,
  };
}

/** The user's language for BAPTOU's emails (set in the app; English by default). */
export async function userLang(uid: string): Promise<Lang> {
  return (await db.doc(`users/${uid}`).get()).get("lang") === "fr" ? "fr" : "en";
}

/**
 * Emails the user at their sign-in address, from BAPTOU, in their language when `mail` is a function of
 * it. Never throws: a failed email must not fail the action.
 */
export async function emailUser(uid: string, mail: Mail | ((lang: Lang) => Mail)) {
  let subject = "";
  try {
    // Only to a confirmed address: BAPTOU's mailbox must never write to an address someone merely typed.
    const user = await getAuth().getUser(uid);
    const to = user.emailVerified ? user.email : undefined;
    if (!to) return false;
    const content = typeof mail === "function" ? mail(await userLang(uid)) : mail;
    subject = content.subject;
    await sendMail(await senderGmail(), { to, fromName: "BAPTOU", ...content });
    return true;
  } catch (e) {
    logger.error("Email to user failed", { uid, subject, error: String(e) });
    return false;
  }
}

// --- Alerts to BAPTOU's owner (in French): a free search launched, a plan bought. They go to config/app.alertEmail
// when set, otherwise to the owner's sign-in address (config/app.ownerUid).

const PLAN_FR: Record<string, string> = { monthly: "Mensuel", annual: "Annuel", pass: "Pass un mois" };
const KIND_FR: Record<string, string> = { internship: "stage", job: "emploi", alternance: "alternance", masters: "master" };
const nowParis = () => new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "long", timeStyle: "short" });

/** Emails the owner. Never throws: the user's action must not fail because of an alert. */
async function alertOwner(mail: Mail) {
  try {
    const config = await db.doc("config/app").get();
    const ownerUid = config.get("ownerUid") as string | undefined;
    const to = (config.get("alertEmail") as string | undefined) ?? (ownerUid ? (await getAuth().getUser(ownerUid)).email : undefined);
    if (!to) return logger.warn("No address for owner alerts", { subject: mail.subject });
    await sendMail(await senderGmail(), { to, fromName: "BAPTOU Alertes", ...mail });
  } catch (e) {
    logger.error("Owner alert failed", { subject: mail.subject, error: String(e) });
  }
}

/** Someone launched their free search (sent once per person, when its first run is queued). */
export async function alertFreeSearch(email: string, search: { name?: string; kind?: string }) {
  const total = await db.collection("trialEmails").count().get().then((r) => r.data().count).catch(() => null);
  await alertOwner({
    subject: `🔎 Recherche gratuite lancée sur BAPTOU (${email})`,
    body: `Quelqu'un vient de lancer sa recherche gratuite sur BAPTOU.

Compte : ${email}
Recherche : « ${search.name || "sans nom"} » (${KIND_FR[search.kind ?? ""] ?? "stage"})
Date : ${nowParis()}
${total != null ? `\nRecherches gratuites depuis le 19 octobre 2026 : ${total}\n` : ""}
Suivi dans BAPTOU Admin (tuile « Free searches »).

BAPTOU`,
  });
}

/** Someone bought a plan (a new subscription or a one-month pass, not a renewal). */
export async function alertPurchase(email: string, plan: string, amountCents: number | null) {
  const amount = amountCents != null ? `${(amountCents / 100).toFixed(2).replace(".", ",")} €` : "montant inconnu";
  // Plans live now (a one-month pass stays "active" after it ends, so its end date is checked too).
  const paying = await db
    .collection("private")
    .where("plan.status", "in", ["active", "past_due"])
    .get()
    .then((s) => s.docs.filter((d) => ((d.get("plan.currentPeriodEnd") as FirebaseFirestore.Timestamp | undefined)?.toMillis() ?? Infinity) > Date.now()).length)
    .catch(() => null);
  await alertOwner({
    subject: `💶 Nouvel abonnement BAPTOU : ${PLAN_FR[plan] ?? plan} (${amount})`,
    body: `Bonne nouvelle : quelqu'un vient de payer BAPTOU !

Compte : ${email}
Formule : ${PLAN_FR[plan] ?? plan}
Montant : ${amount}
Date : ${nowParis()}
${paying != null ? `\nAbonnés payants en cours : ${paying}\n` : ""}
Paiements sur Stripe : https://dashboard.stripe.com/payments

BAPTOU`,
  });
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
  const sorted = [...offers].sort((a, b) => b.matchScore - a.matchScore);
  const ideal = sorted.filter((o) => o.matchScore >= IDEAL_SCORE).slice(0, 2);
  const name = (lang: Lang) => searchName || (lang === "fr" ? "votre recherche" : "your search");
  if (ideal.length) {
    for (const o of ideal) {
      await emailUser(uid, (lang) => idealEmail(o, searchId, name(lang), offers.length - ideal.length, lang));
    }
  } else {
    await emailUser(uid, (lang) => digestEmail(sorted, searchId, name(lang), lang));
  }
}
