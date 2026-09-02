import { DEFAULT_MODEL_CHAIN, resetModelState, unusableModels } from "@srectl/agents";
import { loadEnv } from "@srectl/core";

/**
 * Inspect or clear the model cooldown.
 *
 * The cooldown is a guess: a per-minute limit and an exhausted daily quota are
 * indistinguishable from the API's response, so a model that would actually
 * work can sit on cooldown for up to 15 minutes. This is the escape hatch.
 */
const env = loadEnv();
const action = process.argv[2] ?? "status";

if (action === "reset") {
  resetModelState();
  console.log("cooldowns cleared — every model will be retried");
  process.exit(0);
}

const blocked = new Map(unusableModels().map((u) => [u.model, u]));

console.log(`\npinned model: ${env.GEMINI_MODEL ?? "(none — the chain applies)"}\n`);
console.table(
  DEFAULT_MODEL_CHAIN.map((model, i) => {
    const b = blocked.get(model);
    return {
      "#": i + 1,
      model,
      status: b ? "on cooldown" : "available",
      why: b?.why ?? "",
      "resumes in": b ? `${Math.round((b.until - Date.now()) / 1000)}s` : "",
    };
  }),
);

if (blocked.size === DEFAULT_MODEL_CHAIN.length) {
  console.log("\nEvery model is on cooldown. Either the daily quota is spent, or a");
  console.log("per-minute limit was mistaken for exhaustion. `pnpm models reset` to retry now.");
}
