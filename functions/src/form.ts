import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";
import { loadProfile, runAgent, today } from "./agent.js";
import { anthropicKey, db, REGION } from "./shared.js";

const Entry = z.object({
  title: z.string().describe("Job title, or degree"),
  organization: z.string().describe("Company, or school"),
  location: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  description: z.string().describe("Ready to paste into the form's description box"),
});

const Field = z.object({
  label: z.string().describe("Exactly as on the form when seen, otherwise the usual label"),
  kind: z.enum(["file", "short_text", "long_text", "choice", "yes_no", "entries", "checkbox"]),
  required: z.boolean(),
  charLimit: z.number().describe("Character limit shown on the form, 0 if none"),
  options: z.array(z.string()).describe("Choices for choice fields, empty otherwise"),
  value: z.string().describe("The prepared answer. Empty if only the student can answer (needsUser)"),
  suggestedDocument: z
    .enum(["cv", "transcript", "motivation_letter", "diploma", "other", "none"])
    .describe("For file fields: which of the student's documents to attach"),
  entries: z.array(Entry).describe("For 'entries' fields (experience, education lists), otherwise empty"),
  needsUser: z.boolean().describe("True for facts BAPTOU cannot know: phone, address, work permit, salary, consents"),
  note: z.string().describe("Short tip for the student about this field, or empty"),
});

export const FormSchema = z.object({
  platform: z.string().describe("Application system: Workday, Greenhouse, Lever, SmartRecruiters, Teamtailor, company website, email, ..."),
  formUrl: z.string().describe("URL of the actual application form, or the posting URL if the form couldn't be reached"),
  seenOnForm: z.boolean().describe("True if you saw the real form fields; false if the form is inferred from the platform/posting"),
  notes: z.string().describe("1-3 sentences for the student: how to apply, deadline, anything unusual"),
  sections: z.array(
    z.object({
      title: z.string().describe("e.g. Attachments, Personal information, Experience, Education, Questions"),
      fields: z.array(Field),
    }),
  ),
});

const SYSTEM = `You are BAPTOU. You prepare a student's application in the exact format of the organization's application form.

1. Open the posting link. Find the real application form ("Apply" button, careers portal, ATS page) and open it if you can.
2. List the form's sections and fields in order, using the form's own labels, limits and choices.
   If the form can't be opened (login wall, JavaScript-only page), infer the fields from the posting and the usual layout of that platform, and set seenOnForm to false.
3. Prepare every answer from the student's profile and documents, in the language of the form:
   - "entries" fields (work experience, education): one entry per relevant item, descriptions ready to paste.
   - Free-text questions (message to the hiring team, why us, ...): tailored, specific answers within the character limit, consistent with the motivation letter if there is one.
   - File fields: say which document to attach.
4. Never invent facts. Anything only the student can answer (phone, address, work authorization, salary expectations, consents, diversity questions) gets needsUser = true and an empty value.
When done, call submit_form exactly once.`;

async function readForm(uid: string, app: FirebaseFirestore.DocumentData, profile: Record<string, unknown>) {
  const docs = await db.collection(`users/${uid}/documents`).select("kind", "fileName").get();
  const documentList = docs.docs.map((d) => `- ${d.get("kind")}: ${d.get("fileName")}`).join("\n");
  const letter = app.letter ? `:\n"""\n${app.letter}\n"""` : ": not written yet";

  return runAgent({
    uid,
    system: SYSTEM,
    maxSearches: 8,
    submit: { name: "submit_form", description: "Return the application form with prepared answers.", schema: FormSchema },
    prompt: [
      { type: "text", text: `Student profile:\n${JSON.stringify(profile, null, 2)}` },
      {
        type: "text",
        text: `Today is ${today()}.
${app.type === "masters" ? "Master's programme" : "Internship"}: ${app.title} at ${app.organization}
Posting link: ${app.applyUrl}

Student's uploaded documents:
${documentList || "none"}

Motivation letter${letter}`,
      },
    ],
  });
}

/** Reads the real application form and prepares every field in its format. */
export const prepareApplication = onCall(
  { region: REGION, secrets: [anthropicKey], timeoutSeconds: 540, memory: "512MiB" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
    const applicationId = z.string().min(1).parse(request.data?.applicationId);

    const appRef = db.doc(`users/${uid}/applications/${applicationId}`);
    const app = (await appRef.get()).data();
    if (!app) throw new HttpsError("not-found", "Application not found.");
    if (!app.applyUrl) throw new HttpsError("failed-precondition", "This offer has no link to an application page.");

    // Skip if a run is already in progress (e.g. the offer is open in two tabs). A run that died
    // without reporting back (timeout) is considered stale after 10 minutes.
    const startedAt = app.applicationFormStartedAt?.toMillis?.() ?? 0;
    if (app.applicationFormStatus === "preparing" && Date.now() - startedAt < 10 * 60_000) return null;

    const profile = await loadProfile(uid);
    await appRef.update({
      applicationFormStatus: "preparing",
      applicationFormStartedAt: FieldValue.serverTimestamp(),
      applicationFormError: FieldValue.delete(),
    });

    try {
      const form = await readForm(uid, app, profile);
      await appRef.update({
        applicationForm: { ...form, preparedAt: FieldValue.serverTimestamp() },
        applicationFormStatus: "ready",
        updatedAt: FieldValue.serverTimestamp(),
      });
      return form;
    } catch (e) {
      await appRef.update({
        applicationFormStatus: "error",
        applicationFormError: e instanceof HttpsError ? e.message : "BAPTOU couldn't read this application form.",
      });
      throw e;
    }
  },
);
