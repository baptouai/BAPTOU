import { logger } from "firebase-functions/v2";
import { onSchedule } from "firebase-functions/v2/scheduler";
import type { z } from "zod";
import { submitTool } from "./agent.js";
import { AnswerSchema } from "./ask.js";
import { ContactsSchema, IndexDraftSchema } from "./contacts.js";
import { FormSchema } from "./form.js";
import { ShortenSchema } from "./limits.js";
import { PostingSchema } from "./manual.js";
import { ProfileSchema } from "./profile.js";
import { RepliesSchema } from "./replies.js";
import { AlternanceSchema, JobsSchema, OffersSchema, ProgrammesSchema } from "./search.js";
import { anthropicKey, claude, MODELS, REGION, usesFederation } from "./shared.js";
import { UnlockResultSchema } from "./unlock.js";
import { EmailSchema, LetterSchema } from "./writing.js";

// Every answer format BAPTOU asks Claude for. Strict tool schemas reject some JSON Schema keywords, so
// each is checked here with a token count, which is free.
const SCHEMAS: [string, z.ZodType][] = [
  ["offers", OffersSchema],
  ["jobs", JobsSchema],
  ["alternances", AlternanceSchema],
  ["programmes", ProgrammesSchema],
  ["form", FormSchema],
  ["letter", LetterSchema],
  ["email", EmailSchema],
  ["answer", AnswerSchema],
  ["contacts", ContactsSchema],
  ["index_draft", IndexDraftSchema],
  ["posting", PostingSchema],
  ["shorten", ShortenSchema],
  ["replies", RepliesSchema],
  ["profile", ProfileSchema],
  ["unlock", UnlockResultSchema],
];

/**
 * Every Monday: checks that BAPTOU can still authenticate to Claude (federation or API key), and that
 * every answer format is accepted, with token counts, which are free. A failure shows in the logs before
 * users notice. Can also be run by hand from Cloud Scheduler, e.g. right after a deploy.
 */
export const claudeAuthCheck = onSchedule(
  { region: REGION, schedule: "every monday 08:00", timeZone: "Europe/Paris", secrets: [anthropicKey] },
  async () => {
    const method = usesFederation() ? "federation" : "api key";
    try {
      const { input_tokens } = await claude().beta.messages.countTokens({
        model: MODELS.search,
        messages: [{ role: "user", content: "ping" }],
      });
      logger.info("Claude auth OK", { method, input_tokens });
    } catch (e) {
      logger.error("Claude auth FAILED", { method, error: String(e) });
      throw e;
    }

    const failed: string[] = [];
    for (const [name, schema] of SCHEMAS) {
      try {
        await claude().beta.messages.countTokens({
          model: MODELS.search,
          tools: [submitTool(`submit_${name}`, "Schema check", schema)],
          messages: [{ role: "user", content: "ping" }],
        });
      } catch (e) {
        failed.push(name);
        logger.error("Answer format rejected", { name, error: String(e) });
      }
    }
    if (failed.length) throw new Error(`Answer formats rejected: ${failed.join(", ")}`);
    logger.info("Answer formats OK", { checked: SCHEMAS.length });
  },
);
