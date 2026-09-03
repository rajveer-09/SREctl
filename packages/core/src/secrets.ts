import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

/**
 * Reads configuration from Secret Manager when running in GCP, and from the
 * environment otherwise.
 *
 * The point is that no code has to know which. A Cloud Run service and a local
 * `pnpm dev` both call loadSecrets() and get the same shape; only the source
 * differs. Values are cached because Secret Manager charges per access and a
 * container that re-reads on every request pays for the same string forever.
 *
 * Callers pass the secrets they actually use. Loading the whole set by default
 * would force the internet-facing ingest service to hold the Gemini key and a
 * database password it never touches, so a compromise there would hand over
 * credentials it had no reason to have.
 */

const cache = new Map<string, string>();

export interface SecretSpec {
  /** Environment variable name, e.g. GITHUB_TOKEN. */
  env: string;
  /** Secret Manager secret id, e.g. github-token. */
  secret: string;
  required?: boolean;
}

export const SECRETS: SecretSpec[] = [
  { env: "GITHUB_WEBHOOK_SECRET", secret: "github-webhook-secret", required: true },
  { env: "GITHUB_TOKEN", secret: "github-token", required: true },
  { env: "GEMINI_API_KEY", secret: "gemini-api-key", required: true },
  { env: "DATABASE_URL", secret: "database-url", required: true },
];

export interface LoadSecretsOptions {
  projectId?: string;
  /**
   * Environment-variable names to load. Omitting it loads every secret, which
   * is what local development wants and what a deployed service should not.
   */
  only?: readonly string[];
}

export async function loadSecrets(opts: LoadSecretsOptions = {}): Promise<void> {
  const project =
    opts.projectId ?? process.env["GOOGLE_CLOUD_PROJECT"] ?? process.env["SRECTL_PROJECT"];

  // No project means local development: the environment already has them.
  if (!project) return;

  const wanted = opts.only ? SECRETS.filter((s) => opts.only!.includes(s.env)) : SECRETS;
  if (opts.only) {
    const unknown = opts.only.filter((e) => !SECRETS.some((s) => s.env === e));
    if (unknown.length > 0) {
      // A typo here fails open - the secret is simply never loaded, and the
      // service dies later on a missing value with no hint as to why.
      throw new Error(`loadSecrets: unknown secret env name(s): ${unknown.join(", ")}`);
    }
  }

  const client = new SecretManagerServiceClient();

  for (const spec of wanted) {
    // An explicit environment variable always wins, so a deployment can
    // override one value without rewriting the secret.
    if (process.env[spec.env]) continue;
    if (cache.has(spec.env)) {
      process.env[spec.env] = cache.get(spec.env);
      continue;
    }

    try {
      const [version] = await client.accessSecretVersion({
        name: `projects/${project}/secrets/${spec.secret}/versions/latest`,
      });
      const value = version.payload?.data?.toString();
      if (value) {
        cache.set(spec.env, value);
        process.env[spec.env] = value;
      }
    } catch (err) {
      if (spec.required) {
        throw new Error(
          `could not read secret "${spec.secret}" from project ${project}: ${(err as Error).message}`,
        );
      }
    }
  }
}
