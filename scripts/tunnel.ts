import { loadEnv } from "@srectl/core";
import SmeeClient from "smee-client";

const env = loadEnv();

if (!env.SMEE_URL) {
  console.error("SMEE_URL is not set. See Gate 0.3 in srectl-implementation-plan.md.");
  process.exit(1);
}

const target = `http://localhost:${env.PORT}/webhook`;

const smee = new SmeeClient({
  source: env.SMEE_URL,
  target,
  logger: console,
});

await smee.start();
console.log(`[tunnel] ${env.SMEE_URL}  ->  ${target}`);
