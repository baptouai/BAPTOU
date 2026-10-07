import type Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import mammoth from "mammoth";
import { z } from "zod";
import { anthropicKey, assertBudget, bucket, claude, db, fallbackFor, MODELS, recordUsage, REGION } from "./shared.js";

const MAX_DOCUMENTS = 15;

export const ProfileSchema = z.object({
  fullName: z.string(),
  headline: z.string().describe("One-line summary, e.g. 'Business graduate seeking a finance master's abroad'"),
  education: z.array(
    z.object({
      degree: z.string(),
      field: z.string(),
      institution: z.string(),
      country: z.string(),
      startYear: z.string(),
      endYear: z.string(),
      grade: z.string().describe("Overall grade/GPA as written in the documents, or empty"),
      highlights: z.array(z.string()).describe("Notable courses, thesis, ranking, honours"),
    }),
  ),
  experience: z.array(
    z.object({
      role: z.string(),
      organization: z.string(),
      country: z.string(),
      period: z.string(),
      achievements: z.array(z.string()),
    }),
  ),
  skills: z.array(z.string()),
  languages: z.array(z.object({ language: z.string(), level: z.string() })),
  interests: z.array(z.string()),
  strengths: z.array(z.string()).describe("What makes this candidate stand out, backed by the documents"),
  gaps: z.array(z.string()).describe("Weak points an application should address or avoid"),
  writingStyle: z
    .string()
    .describe("How this person writes motivation letters: tone, structure, typical openings, language. Empty if no letters."),
  suggestedTargets: z.object({
    internshipRoles: z.array(z.string()),
    mastersFields: z.array(z.string()),
  }),
});

export type Profile = z.infer<typeof ProfileSchema>;

const SYSTEM = `You are BAPTOU, a careers and admissions assistant for students.
You read a student's documents (CVs, transcripts, diplomas, past motivation letters) and build an accurate profile.
Only state facts present in the documents. When documents disagree, prefer the most recent one.
Keep the student's own wording for achievements where possible. Write the profile in English.`;

export async function toContentBlock(d: FirebaseFirestore.DocumentData): Promise<Anthropic.Beta.BetaContentBlockParam | null> {
  const [buffer] = await bucket().file(d.storagePath).download();
  const title = `${d.kind}: ${d.fileName}`;
  if (d.contentType === "application/pdf") {
    return {
      type: "document",
      title,
      source: { type: "base64", media_type: "application/pdf", data: buffer.toString("base64") },
    };
  }
  if (d.fileName.toLowerCase().endsWith(".docx")) {
    const { value } = await mammoth.extractRawText({ buffer });
    return { type: "document", title, source: { type: "text", media_type: "text/plain", data: value } };
  }
  return null; // legacy .doc and other formats are skipped
}

/** Reads every uploaded document and writes a structured profile to users/{uid}.profile. */
export const buildProfile = onCall(
  { region: REGION, secrets: [anthropicKey], timeoutSeconds: 300, memory: "1GiB" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");

    const docsSnap = await db
      .collection(`users/${uid}/documents`)
      .orderBy("uploadedAt", "desc")
      .limit(MAX_DOCUMENTS)
      .get();
    if (docsSnap.empty) throw new HttpsError("failed-precondition", "Upload at least one document first.");
    await assertBudget(uid);

    const blocks = (await Promise.all(docsSnap.docs.map((d) => toContentBlock(d.data())))).filter(
      (b): b is Anthropic.Beta.BetaContentBlockParam => b !== null,
    );
    if (blocks.length === 0) {
      throw new HttpsError("failed-precondition", "None of your documents could be read. Upload PDF or .docx files.");
    }

    const response = await claude().beta.messages.parse({
      model: MODELS.profile,
      max_tokens: 16000,
      ...fallbackFor(MODELS.profile),
      output_config: { effort: "medium", format: betaZodOutputFormat(ProfileSchema) },
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [...blocks, { type: "text", text: "Build my profile from these documents." }],
        },
      ],
    });
    await recordUsage(uid, MODELS.profile, response.usage, "profile");

    if (response.stop_reason === "refusal" || !response.parsed_output) {
      throw new HttpsError("internal", "BAPTOU couldn't build your profile from these documents. Try again.");
    }

    await db.doc(`users/${uid}`).set(
      { profile: response.parsed_output, profileUpdatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return { profile: response.parsed_output };
  },
);
