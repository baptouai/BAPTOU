import { logger } from "firebase-functions/v2";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { anthropicKey, claude, MODELS, REGION, usesFederation } from "./shared.js";

/**
 * Every Monday: checks that BAPTOU can still authenticate to Claude (federation or API key), with a token
 * count, which is free. A failure shows in the logs before users notice. Can also be run by hand from Cloud
 * Scheduler, e.g. right after changing credentials.
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
  },
);
