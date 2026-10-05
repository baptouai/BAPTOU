import type Anthropic from "@anthropic-ai/sdk";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";
import { loadProfile, runAgent, today } from "./agent.js";
import { toContentBlock } from "./profile.js";
import { anthropicKey, db, MODELS, REGION } from "./shared.js";

const Input = z.object({
  applicationId: z.string().min(1),
  instructions: z.string().max(2000).optional().default(""),
});

export const LetterSchema = z.object({
  research: z.string().describe("4-6 facts on the organization: what it does, recent news, values, the team if known. Bullet points: one per line, each starting with '- ', max 12 words each, no paragraphs."),
  approachNote: z.string().describe("2-4 points for the student: the angle the letter takes and why. Bullet points: one per line, each starting with '- ', max 12 words each, no paragraphs."),
  letter: z.string().describe("The full motivation letter, ready to send, in plain text"),
  packFields: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .describe("Answers the application form is likely to ask for (why us, why this role, availability, ...), ready to copy"),
});

export const EmailSchema = z.object({
  to: z.string().describe("Recipient email address if publicly listed for this posting, otherwise empty"),
  subject: z.string(),
  body: z.string(),
});

const WRITER_SYSTEM = `You are BAPTOU, a writing assistant for students applying to internships and master's programmes.
You write in the student's own voice, using their writing style notes and past letters as a model.

Rules:
- Use only facts from the student's profile and documents. Never invent experience, grades or skills.
- Research the organization on the web so the letter is specific (projects, values, recent news) rather than generic.
- Write in the language of the posting unless the student asks otherwise.
- Be concise and concrete: link the student's real achievements to what this organization needs.
- If the student gives instructions or has edited a draft, follow their instructions and keep their edits unless told otherwise.`;

async function loadContext(uid: string, applicationId: string) {
  const appRef = db.doc(`users/${uid}/applications/${applicationId}`);
  const app = (await appRef.get()).data();
  if (!app) throw new HttpsError("not-found", "Application not found.");
  const profile = await loadProfile(uid);

  // Up to two past letters, so the draft sounds like the student.
  const lettersSnap = await db
    .collection(`users/${uid}/documents`)
    .where("kind", "==", "motivation_letter")
    .limit(2)
    .get();
  const pastLetters = (await Promise.all(lettersSnap.docs.map((d) => toContentBlock(d.data())))).filter(
    (b): b is Anthropic.Beta.BetaContentBlockParam => b !== null,
  );
  return { appRef, app, profile, pastLetters };
}

function describeApplication(app: FirebaseFirestore.DocumentData) {
  return `${app.type === "masters" ? "Master's programme" : "Internship"}: ${app.title}
Organization: ${app.organization}${app.location ? `, ${app.location}` : ""}${app.country ? ` (${app.country})` : ""}
Link: ${app.applyUrl ?? "none"}
Posting language: ${app.postingLanguage ?? "unknown"}
Why it was suggested: ${app.matchReason ?? ""}
Current research notes: ${app.research ?? "none"}`;
}

/** Writes (or rewrites, following the student's instructions) the motivation letter for one application. */
export const draftLetter = onCall(
  { region: REGION, secrets: [anthropicKey], timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
    const { applicationId, instructions } = Input.parse(request.data);
    const { appRef, app, profile, pastLetters } = await loadContext(uid, applicationId);
    const current: string = app.letter ?? "";

    const result = await runAgent({
      uid,
      system: WRITER_SYSTEM,
      model: MODELS.letter,
      task: "letter",
      web: { searches: 3, fetches: 2 },
      effort: "high",
      submit: { name: "submit_letter", description: "Return the letter, research and application answers.", schema: LetterSchema },
      prompt: [
        ...pastLetters,
        { type: "text", text: `Student profile:\n${JSON.stringify(profile, null, 2)}` },
        {
          type: "text",
          text: `Today is ${today()}.
${describeApplication(app)}

${current ? `Current letter (may include the student's own edits):\n"""\n${current}\n"""` : "There is no letter yet."}

${instructions ? `Student's instructions: ${instructions}` : current ? "Improve this letter." : "Write the motivation letter."}`,
        },
      ],
    });

    // Keep the previous text in the history so a rewrite can always be undone.
    if (current) {
      await appRef.collection("letterVersions").add({ text: current, author: "user", createdAt: FieldValue.serverTimestamp() });
    }
    await appRef.collection("letterVersions").add({ text: result.letter, author: "baptou", createdAt: FieldValue.serverTimestamp() });
    await appRef.update({
      letter: result.letter,
      research: result.research,
      approachNote: result.approachNote,
      packFields: result.packFields,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return result;
  },
);

/** Drafts (or rewrites) the email for one application. Never sends anything. */
export const draftEmail = onCall(
  { region: REGION, secrets: [anthropicKey], timeoutSeconds: 300, memory: "1GiB" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
    const { applicationId, instructions } = Input.parse(request.data);
    const { appRef, app, profile, pastLetters } = await loadContext(uid, applicationId);
    if (app.emailSentAt) throw new HttpsError("failed-precondition", "This email was already sent.");

    const current = app.emailDraft as { to: string; subject: string; body: string } | undefined;
    const result = await runAgent({
      uid,
      system: WRITER_SYSTEM,
      model: MODELS.email,
      task: "email",
      web: { searches: 1, fetches: 1 },
      effort: "medium",
      submit: { name: "submit_email", description: "Return the email draft.", schema: EmailSchema },
      prompt: [
        ...pastLetters,
        { type: "text", text: `Student profile:\n${JSON.stringify(profile, null, 2)}` },
        {
          type: "text",
          text: `Today is ${today()}.
${describeApplication(app)}

Motivation letter for this application (attach-ready):
"""
${app.letter || "(none yet)"}
"""

${current ? `Current email draft:\nTo: ${current.to}\nSubject: ${current.subject}\n"""\n${current.body}\n"""` : "There is no email yet."}

${instructions ? `Student's instructions: ${instructions}` : current ? "Improve this email." : "Write a short application email to send with the CV and letter attached."}`,
        },
      ],
    });

    const emailDraft = { to: result.to || current?.to || "", subject: result.subject, body: result.body };
    await appRef.update({
      emailDraft,
      emailApprovedAt: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return emailDraft;
  },
);
