import type Anthropic from "@anthropic-ai/sdk";
import { HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { z } from "zod";
import { assertBudget, claude, db, fallbackFor, type Model, recordUsage, type Task } from "./shared.js";

const MAX_CONTINUATIONS = 4;
// Hard ceiling per task run: past it, BAPTOU is told to answer with what it already has.
const DEFAULT_MAX_RUN_USD = 0.75;
// Web pages are cut to this size. Whole career sites can be 50k+ tokens and were the main cost.
const MAX_PAGE_TOKENS = 6000;

export type WebBudget = { searches: number; fetches: number };
// `limited`: the run stopped because it reached its spending or browsing limits, not because it was done.
export type AgentStats = { costUsd: number; searches?: number; fetches?: number; limited?: boolean };

export const webTools = (
  { searches, fetches }: WebBudget,
  pageTokens = MAX_PAGE_TOKENS,
): Anthropic.Beta.BetaToolUnion[] => [
  { type: "web_search_20260209", name: "web_search", max_uses: searches },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: fetches, max_content_tokens: pageTokens },
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

/** A tool BAPTOU runs itself (e.g. Gmail search); its result is sent back to Claude as text. */
export type ClientTool = {
  name: string;
  description: string;
  schema: z.ZodType;
  run: (input: unknown) => Promise<string>;
};

/**
 * Runs Claude until it calls the `submit` tool, and returns that tool's validated input.
 * Web search/fetch run on Anthropic's side (we only continue on pause_turn); client tools run here.
 */
export async function runAgent<T>(opts: {
  uid: string;
  system: string;
  prompt: Anthropic.Beta.BetaContentBlockParam[];
  submit: { name: string; description: string; schema: z.ZodType<T> };
  model: Model;
  task: Task; // for the per-task spending breakdown
  web: WebBudget | null;
  clientTools?: ClientTool[];
  maxToolCalls?: number; // ceiling on client tool calls, default 10
  maxRunUsd?: number; // spending ceiling for this run, default $0.75
  maxPageTokens?: number; // size cap for each fetched web page
  stats?: AgentStats; // filled with this run's cost and web use
  effort?: "low" | "medium" | "high";
}): Promise<T> {
  await assertBudget(opts.uid);
  const clientTools = opts.clientTools ?? [];
  const tools = [
    ...(opts.web ? webTools(opts.web, opts.maxPageTokens) : []),
    ...clientTools.map((t) => submitTool(t.name, t.description, t.schema)),
    submitTool(opts.submit.name, opts.submit.description, opts.submit.schema),
  ];
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: opts.prompt }];
  const maxToolCalls = opts.maxToolCalls ?? 10;
  let toolCalls = 0;
  let nudged = false;
  let runCost = 0;
  let searches = 0;
  let fetches = 0;
  let limited = false;
  const visited: string[] = []; // search queries and opened pages, for the log
  const done = (turns: number) => {
    if (opts.stats) Object.assign(opts.stats, { costUsd: runCost, searches, fetches, limited });
    logger.info("Agent run", { task: opts.task, turns, costUsd: Math.round(runCost * 1000) / 1000, searches, fetches, limited, visited: visited.slice(0, 40) });
  };

  for (let i = 0; i < MAX_CONTINUATIONS + maxToolCalls; i++) {
    const response = await claude()
      .beta.messages.stream({
        model: opts.model,
        max_tokens: 32000,
        ...fallbackFor(opts.model),
        output_config: { effort: opts.effort ?? "medium" },
        // Caching: the system prompt is a fixed breakpoint, and the top-level field caches the growing
        // tail, so content Claude re-reads during the loop is billed at 10% instead of in full.
        cache_control: { type: "ephemeral" },
        system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
        tools,
        messages,
      })
      .finalMessage();
    runCost += await recordUsage(opts.uid, opts.model, response.usage, opts.task);
    searches += response.usage.server_tool_use?.web_search_requests ?? 0;
    fetches += response.usage.server_tool_use?.web_fetch_requests ?? 0;
    for (const b of response.content) {
      if (b.type === "server_tool_use") {
        const input = b.input as { query?: string; url?: string };
        visited.push(`${b.name === "web_fetch" ? "open" : "search"}: ${(input.query ?? input.url ?? "").slice(0, 120)}`);
      }
    }
    if (opts.stats) opts.stats.costUsd = runCost;
    if (opts.web && (searches >= opts.web.searches || fetches >= opts.web.fetches)) limited = true;

    if (response.stop_reason === "refusal") {
      throw new HttpsError("internal", "BAPTOU couldn't complete this request.");
    }

    const uses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    const call = uses.find((b) => b.name === opts.submit.name);
    if (call) {
      const parsed = opts.submit.schema.safeParse(call.input);
      done(i + 1);
      if (parsed.success) return parsed.data;
      throw new HttpsError("internal", "BAPTOU returned an incomplete answer. Try again.");
    }

    messages.push({ role: "assistant", content: response.content });
    const overBudget = runCost >= (opts.maxRunUsd ?? DEFAULT_MAX_RUN_USD) || toolCalls >= maxToolCalls;
    if (overBudget) limited = true;

    if (response.stop_reason === "tool_use" && uses.length) {
      // All results go back in one user message, as the API expects.
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = await Promise.all(
        uses.map(async (use) => {
          const tool = clientTools.find((t) => t.name === use.name);
          if (!tool) return { type: "tool_result" as const, tool_use_id: use.id, is_error: true, content: "Unknown tool." };
          if (overBudget) {
            return { type: "tool_result" as const, tool_use_id: use.id, is_error: true, content: `Limit reached. Call ${opts.submit.name} now with what you have.` };
          }
          toolCalls++;
          const parsed = tool.schema.safeParse(use.input);
          if (!parsed.success) return { type: "tool_result" as const, tool_use_id: use.id, is_error: true, content: "Invalid input." };
          try {
            return { type: "tool_result" as const, tool_use_id: use.id, content: await tool.run(parsed.data) };
          } catch (e) {
            return { type: "tool_result" as const, tool_use_id: use.id, is_error: true, content: e instanceof Error ? e.message : "Tool failed." };
          }
        }),
      );
      messages.push({ role: "user", content: results });
      if (overBudget) nudged = true;
      continue;
    }

    if (response.stop_reason === "pause_turn" && !overBudget) continue;
    if (nudged) break;
    nudged = true;
    messages.push({ role: "user", content: `Now call ${opts.submit.name} with your final answer.` });
  }
  done(MAX_CONTINUATIONS + maxToolCalls);
  throw new HttpsError("deadline-exceeded", "BAPTOU took too long. Try again.");
}

/** Loads the profile built by `buildProfile`, or fails with a clear message. */
export async function loadProfile(uid: string) {
  const snap = await db.doc(`users/${uid}`).get();
  const profile = snap.get("profile");
  if (!profile) throw new HttpsError("failed-precondition", "Build your profile first (Profile page).");
  // Nationalities are entered by the student on the Profile page (kept apart from the AI-built profile,
  // so rebuilding it never erases them). They decide work permits, visas and tuition fee status.
  const nationalities = (snap.get("nationalities") as string[] | undefined) ?? [];
  return { ...(profile as Record<string, unknown>), ...(nationalities.length ? { nationalities } : {}) };
}

export const today = () => new Date().toISOString().slice(0, 10);
