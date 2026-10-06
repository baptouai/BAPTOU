import { FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { GMAIL_SECRETS } from "./gmail.js";
import { APP_URL, emailUser, longDate } from "./notify.js";
import { db, type Plan, REGION } from "./shared.js";

// French consumer law asks that subscribers be told, in writing, between 3 months and 1 month before a
// commitment ends, what happens next and how to stop. Sent once per commitment, about 2 months before.

const DAY = 86_400_000;
const NOTICE_DAYS = 60;

export const commitmentReminders = onSchedule(
  { region: REGION, schedule: "every day 09:00", timeZone: "Europe/Paris", secrets: GMAIL_SECRETS },
  async () => {
    const annual = await db.collection("private").where("plan.type", "==", "annual").get();
    let sent = 0;
    for (const doc of annual.docs) {
      const plan = doc.get("plan") as Plan;
      const end = plan.commitmentEnd?.toMillis();
      if (!end || plan.status !== "active" || plan.cancelAt) continue; // cancelled: they already know when it ends
      const left = end - Date.now();
      if (left <= 0 || left > NOTICE_DAYS * DAY) continue;
      if (doc.get("commitmentReminder.for") === end) continue; // already told for this commitment

      const ok = await emailUser(doc.id, (lang) =>
        lang === "fr"
          ? {
              subject: `Votre engagement annuel BAPTOU se termine le ${longDate(end, lang)}`,
              body: `Bonjour,

L'engagement de 12 mois de votre formule annuelle BAPTOU se termine le ${longDate(end, lang)}.

Et ensuite :
- Si vous ne faites rien, votre formule continue mois par mois au même prix mensuel, et vous pouvez la résilier à tout moment.
- Si vous ne souhaitez pas la poursuivre, résiliez-la depuis la page Formules avant le ${longDate(end, lang)} : elle prendra fin à cette date, sans paiement ensuite.

Page Formules : ${APP_URL}/plans

BAPTOU`,
            }
          : {
              subject: `Your BAPTOU yearly commitment ends on ${longDate(end, lang)}`,
              body: `Hi,

Your 12-month commitment for the yearly BAPTOU plan ends on ${longDate(end, lang)}.

What happens next:
- If you do nothing, your plan continues month by month at the same monthly price, and you can cancel it at any time.
- If you don't want it to continue, cancel it from the Plans page before ${longDate(end, lang)}: it will end on that date, with no payment after it.

Plans page: ${APP_URL}/plans

BAPTOU`,
            },
      );
      if (ok) {
        await doc.ref.set({ commitmentReminder: { for: end, sentAt: FieldValue.serverTimestamp() } }, { merge: true });
        sent++;
      }
    }
    logger.info("Commitment reminders", { annual: annual.size, sent });
  },
);
