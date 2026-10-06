import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { GMAIL_SECRETS, sendMail } from "./gmail.js";
import { APP_URL, ownerMailer } from "./notify.js";
import { REGION } from "./shared.js";

// When BAPTOU Admin gifts a subscription with "Send invitation email" ticked, it sets `notify: true` on
// access/{email}. This sends the invitation from the owner's Gmail, then clears the flag.

function invitation(email: string, ownerName: string, until: Date | null) {
  const fr = until ? `jusqu'au ${until.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })}` : "sans date de fin";
  const en = until ? `until ${until.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}` : "with no end date";
  return {
    subject: "Ton accès à BAPTOU / Your access to BAPTOU",
    body: `Bonjour,

${ownerName} t'offre un abonnement à BAPTOU, ${fr}.

BAPTOU est un assistant IA qui trouve des stages, emplois, alternances et masters qui te correspondent, prépare tes candidatures dans le format de chaque formulaire et rédige tes lettres. Rien n'est envoyé sans ton accord.

Pour commencer :
1. Ouvre ${APP_URL} et connecte-toi avec Google, avec cette adresse : ${email}
2. Dans « Profile », ajoute ton CV (et si tu veux tes relevés de notes et une ancienne lettre), puis clique sur « Build my profile ».
3. Dans « Applications », crée ta première recherche.

C'est une version en test : tous tes retours sont les bienvenus, il suffit de répondre à cet email.

---

Hi,

${ownerName} is giving you a BAPTOU subscription, ${en}.

BAPTOU is an AI assistant that finds internships, jobs, alternances and master's programmes that fit you, prepares each application in the format of its form and writes your letters. Nothing is sent without your approval.

To get started:
1. Open ${APP_URL} and sign in with Google using this address: ${email}
2. In "Profile", add your CV (and, if you like, your transcripts and an old letter), then click "Build my profile".
3. In "Applications", create your first search.

This is a test version: any feedback is welcome, just reply to this email.

${ownerName}`,
  };
}

export const sendGiftInvitation = onDocumentWritten(
  { document: "access/{email}", database: "baptou", region: REGION, secrets: GMAIL_SECRETS },
  async (event) => {
    const after = event.data?.after;
    if (!after?.exists || after.get("notify") !== true) return;
    const email = decodeURIComponent(event.params.email);
    try {
      const { gmail, name } = await ownerMailer();
      const until = (after.get("expiresAt") as Timestamp | undefined)?.toDate() ?? null;
      await sendMail(gmail, { to: email, ...invitation(email, name, until) });
      await after.ref.update({ notify: false, notifiedAt: FieldValue.serverTimestamp(), notifyError: FieldValue.delete() });
      logger.info("Gift invitation sent", { email });
    } catch (e) {
      logger.error("Gift invitation failed", { email, error: String(e) });
      await after.ref.update({ notify: false, notifyError: e instanceof Error ? e.message : String(e) });
    }
  },
);
