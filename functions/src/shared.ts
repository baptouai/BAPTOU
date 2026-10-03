import Anthropic from "@anthropic-ai/sdk";
import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { defineSecret } from "firebase-functions/params";

initializeApp();

// BAPTOU uses the named Firestore database "baptou", not "(default)".
export const db = getFirestore("baptou");
// Resolved lazily: the bucket name comes from FIREBASE_CONFIG, which is only set at runtime.
export const bucket = () => getStorage().bucket();

export const REGION = "europe-west1";
export const MODEL = "claude-opus-5";

// Stored in Google Secret Manager: `npx firebase functions:secrets:set ANTHROPIC_API_KEY`
export const anthropicKey = defineSecret("ANTHROPIC_API_KEY");

export function claude() {
  return new Anthropic({ apiKey: anthropicKey.value() });
}

// Server-side refusal fallback: if the main model declines, the API re-runs on a fallback model.
export const FALLBACK: { betas: Anthropic.Beta.AnthropicBeta[]; fallbacks: "default" } = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
};

/** Tracks token usage per user in the server-only `private/{uid}` doc (for quotas and billing later). */
export async function recordUsage(uid: string, usage: { input_tokens: number; output_tokens: number }) {
  await db.doc(`private/${uid}`).set(
    {
      usage: {
        inputTokens: FieldValue.increment(usage.input_tokens),
        outputTokens: FieldValue.increment(usage.output_tokens),
        calls: FieldValue.increment(1),
      },
      lastCallAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}
