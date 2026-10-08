import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";
import { loadProfile, runAgent, today } from "./agent.js";
import { anthropicKey, db, kindLabel, MODELS, REGION, requireAccess } from "./shared.js";

const Input = z.object({
  applicationId: z.string().min(1),
  question: z.string().min(1).max(2000),
});

export const AnswerSchema = z.object({
  answer: z
    .string()
    .describe(
      "Direct, honest answer in the student's language. Start with one short sentence, then bullet points grouped under '**Pros**' and '**Cons**' (or other short bold headings when they fit better). Bullet points: one per line, each starting with '- ', max 12 words each, no paragraphs.",
    ),
  verdict: z.enum(["good_fit", "uncertain", "poor_fit"]),
  verdictReason: z.string().describe("One sentence explaining the verdict"),
  followUpQuestions: z
    .array(z.string())
    .describe("Up to 3 questions to ask the student that would help decide, if anything important is unclear"),
});

const SYSTEM = `You are BAPTOU, a frank career advisor. A student is deciding whether an internship, job, alternance or master's programme is really right for them.
- Answer honestly, including downsides (pay, location, workload, team reputation, career value, visa, timing). Do not oversell.
- Base claims about the organization on web research done now; say when something could not be verified.
- Relate everything to the student's profile, goals and earlier answers in this conversation.
- If the decision depends on something you don't know about the student, ask them (followUpQuestions).
When done, call submit_answer exactly once.`;

/** Q&A about one offer: "is this really for me?". The conversation is kept in applications/{id}/chat. */
export const askAboutOffer = onCall(
  { region: REGION, secrets: [anthropicKey], timeoutSeconds: 300, memory: "512MiB" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
    await requireAccess(uid);
    const { applicationId, question } = Input.parse(request.data);

    const appRef = db.doc(`users/${uid}/applications/${applicationId}`);
    const app = (await appRef.get()).data();
    if (!app) throw new HttpsError("not-found", "Application not found.");
    const profile = await loadProfile(uid);

    const history = await appRef.collection("chat").orderBy("createdAt").limitToLast(20).get();
    const transcript = history.docs
      .map((d) => `${d.get("role") === "user" ? "Student" : "BAPTOU"}: ${d.get("text")}`)
      .join("\n\n");

    const result = await runAgent({
      uid,
      system: SYSTEM,
      model: MODELS.ask,
      task: "ask",
      web: { searches: 2, fetches: 2 },
      effort: "medium",
      submit: { name: "submit_answer", description: "Return the answer and fit verdict.", schema: AnswerSchema },
      prompt: [
        { type: "text", text: `Student profile:\n${JSON.stringify(profile, null, 2)}` },
        {
          type: "text",
          text: `Today is ${today()}.
${kindLabel(app.type)}: ${app.title} at ${app.organization}${app.location ? `, ${app.location}` : ""}
Link: ${app.applyUrl ?? "none"}
Why BAPTOU suggested it: ${app.matchReason ?? ""}
Research notes: ${app.research ?? "none"}

${transcript ? `Conversation so far:\n${transcript}\n\n` : ""}Student: ${question}`,
        },
      ],
    });

    const chat = appRef.collection("chat");
    await chat.add({ role: "user", text: question, createdAt: FieldValue.serverTimestamp() });
    await chat.add({
      role: "baptou",
      text: result.answer,
      verdict: result.verdict,
      verdictReason: result.verdictReason,
      followUpQuestions: result.followUpQuestions.slice(0, 3),
      createdAt: FieldValue.serverTimestamp(),
    });
    await appRef.update({
      fitVerdict: result.verdict,
      fitVerdictReason: result.verdictReason,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return result;
  },
);
