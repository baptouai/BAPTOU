import type Anthropic from "@anthropic-ai/sdk";
import { HttpsError } from "firebase-functions/v2/https";
import { z } from "zod";
import { assertBudget, claude, db, FALLBACK, type Model, recordUsage } from "./shared.js";

const MAX_CONTINUATIONS = 4;
// Hard ceiling per task run: past it, BAPTOU is told to answer with what it already has.
const MAX_RUN_USD = 0.75;
// Web pages are cut to this size. Whole career sites can be 50k+ tokens and were the main cost.
const MAX_PAGE_TOKENS = 6000;

export type WebBudget = { searches: number; fetches: number };

export const webTools = ({ searches, fetches }: WebBudget): Anthropic.Beta.BetaToolUnion[] => [
  { type: "web_search_20260209", name: "web_search", max_uses: searches },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: fetches, max_content_tokens: MAX_PAGE_TOKENS },
];

// JSON Schema keywords strict tool use rejects. Zod adds some implicitly (z.int() emits min/max),
// so they are stripped here; Zod still enforces them when the answer is parsed.
const UNSUPPORTED = new Set(["$schema", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern", "format"]);

function stripUnsupported(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupported);
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node).filter(([k]) => !UNSUPPORTED.has(k)).map(([k, v]) => [k, k === "properties" ? mapValues(v) : stripUnsupported(v)]),
    );
  }
  return node;
}

// Property names are user-defined, so only their schemas are cleaned, never the names themselves.
const mapValues = (props: unknown) =>
  Object.fromEntries(Object.entries(props as Record<string, unknown>).map(([k, v]) => [k, stripUnsupported(v)]));

/** Builds a strict custom tool from a Zod schema; Claude calls it to hand back its final answer. */
export function submitTool(name: string, description: string, schema: z.ZodType): Anthropic.Beta.BetaTool {
  const input_schema = stripUnsupported(z.toJSONSchema(schema)) as Anthropic.Beta.BetaTool.InputSchema;
  return { name, description, strict: true, input_schema };
}

/**
 * Runs Claude with web tools until it calls the `submit` tool, and returns that tool's validated input.
 * Server tools (web search/fetch) run on Anthropic's side; we only loop on pause_turn.
 */
export async function runAgent<T>(opts: {
  uid: string;
  system: string;
  prompt: Anthropic.Beta.BetaContentBlockParam[];
  submit: { name: string; description: string; schema: z.ZodType<T> };
  model: Model;
  web: WebBudget;
  effort?: "low" | "medium" | "high";
}): Promise<T> {
  await assertBudget(opts.uid);
  const tools = [...webTools(opts.web), submitTool(opts.submit.name, opts.submit.description, opts.submit.schema)];
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: opts.prompt }];
  let nudged = false;
  let runCost = 0;

  for (let i = 0; i < MAX_CONTINUATIONS; i++) {
    const response = await claude()
      .beta.messages.stream({
        model: opts.model,
        max_tokens: 32000,
        ...FALLBACK,
        output_config: { effort: opts.effort ?? "medium" },
        // Caching: the system prompt is a fixed breakpoint, and the top-level field caches the growing
        // tail, so pages Claude re-reads during the search loop are billed at 10% instead of in full.
        cache_control: { type: "ephemeral" },
        system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
        tools,
        messages,
      })
      .finalMessage();
    runCost += await recordUsage(opts.uid, opts.model, response.usage);

    if (response.stop_reason === "refusal") {
      throw new HttpsError("internal", "BAPTOU couldn't complete this request.");
    }

    const call = response.content.find(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use" && b.name === opts.submit.name,
    );
    if (call) {
      const parsed = opts.submit.schema.safeParse(call.input);
      if (parsed.success) return parsed.data;
      throw new HttpsError("internal", "BAPTOU returned an incomplete answer. Try again.");
    }

    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason === "pause_turn" && runCost < MAX_RUN_USD) continue;
    if (nudged) break;
    nudged = true;
    messages.push({ role: "user", content: `Now call ${opts.submit.name} with your final answer.` });
  }
  throw new HttpsError("deadline-exceeded", "BAPTOU took too long. Try again.");
}

/** Loads the profile built by `buildProfile`, or fails with a clear message. */
export async function loadProfile(uid: string) {
  const snap = await db.doc(`users/${uid}`).get();
  const profile = snap.get("profile");
  if (!profile) throw new HttpsError("failed-precondition", "Build your profile first (Profile page).");
  return profile as Record<string, unknown>;
}

export const today = () => new Date().toISOString().slice(0, 10);
