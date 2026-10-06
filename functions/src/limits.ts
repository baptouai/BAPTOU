import { z } from "zod";
import { runAgent } from "./agent.js";
import { MODELS } from "./shared.js";

// Application forms often cap answers at N characters. BAPTOU's answers must never exceed the cap:
// over-long texts get one quick shortening pass, then a clean cut as a guarantee.

export type LimitedText = { label: string; limit: number; text: string };

/** Guarantee: cut at the last sentence (or word) that fits. Never longer than `limit`. */
export function hardFit(text: string, limit: number) {
  if (!limit || text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const sentenceEnd = Math.max(...[". ", ".\n", "! ", "? ", "!\n", "?\n"].map((m) => cut.lastIndexOf(m)));
  if (sentenceEnd > limit * 0.6) return cut.slice(0, sentenceEnd + 1).trimEnd();
  const space = cut.lastIndexOf(" ");
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut.slice(0, limit - 1)).trimEnd()}…`;
}

export const ShortenSchema = z.object({ texts: z.array(z.string()).describe("The shortened texts, in the order given") });

const SYSTEM = `You shorten a student's application texts so they fit an application form's character limits.
Keep the facts, the meaning, the tone and the language. Cut filler and repetition first, then less important details.
Each text must be at most its limit in characters (spaces included); aim for about 90% of it.
Call submit_texts once with every text, in the order given.`;

/** Returns the texts, each within its limit (texts with limit 0 are untouched). */
export async function fitToLimits(uid: string, items: LimitedText[]): Promise<string[]> {
  const out = items.map((i) => i.text);
  const over = items.map((it, i) => ({ ...it, i })).filter((it) => it.limit > 0 && it.text.length > it.limit);
  if (over.length) {
    try {
      const res = await runAgent({
        uid,
        system: SYSTEM,
        model: MODELS.form,
        task: "form",
        web: null,
        effort: "low",
        submit: { name: "submit_texts", description: "Return the shortened texts.", schema: ShortenSchema },
        prompt: [
          {
            type: "text",
            text: over
              .map(
                (o, n) =>
                  `#${n + 1} ${o.label}: at most ${o.limit} characters (currently ${o.text.length}).\n"""\n${o.text}\n"""`,
              )
              .join("\n\n"),
          },
        ],
      });
      over.forEach((o, n) => {
        if (res.texts[n]?.trim()) out[o.i] = res.texts[n].trim();
      });
    } catch {
      // The clean cut below still guarantees the limit.
    }
  }
  return out.map((t, i) => hardFit(t, items[i].limit));
}
