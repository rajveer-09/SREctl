import { config as loadDotenv } from "dotenv";
import { z } from "zod";

/**
 * Config is parsed once, at boot, and fails loudly. A missing webhook secret
 * should stop the process on startup — not surface as a silent 401 on the
 * first real delivery from GitHub.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8787),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DATA_DIR: z.string().min(1).default(".data"),

  // Phase 0
  GITHUB_WEBHOOK_SECRET: z
    .string()
    .min(16, "GITHUB_WEBHOOK_SECRET must be at least 16 chars — see Gate 0.3"),
  SMEE_URL: z.string().url().optional(),

  // Phase 1 — optional until those gates are done
  DATABASE_URL: z.string().optional(),
  DATABASE_URL_DIRECT: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  /** Overrides the default model. Each model has its own free-tier quota. */
  GEMINI_MODEL: z.string().optional(),

  // Set only when deployed. Their presence is what selects cloud behaviour,
  // so a local run needs no flags and a deployed one needs no code change.
  SRECTL_PUBSUB_TOPIC: z.string().optional(),
  SRECTL_PUBSUB_SUBSCRIPTION: z.string().optional(),
  GOOGLE_CLOUD_PROJECT: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  TARGET_REPO: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  loadDotenv();

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join("\n")}\n\nCopy .env.example to .env and fill it in.`);
  }

  cached = parsed.data;
  return cached;
}

/** Test helper — lets a suite install a config without touching process.env. */
export function __setEnvForTest(env: Partial<Env> | undefined): void {
  cached = env ? (env as Env) : undefined;
}
