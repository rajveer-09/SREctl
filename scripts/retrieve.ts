import { createLogger, loadEnv } from "@srectl/core";
import { createClient, fetchFile, fetchPullRequest, parseRepo } from "@srectl/github";
import {
  assembleContext,
  countTokens,
  createPool,
  detectTestLayout,
  Embedder,
  readConventions,
} from "@srectl/retrieval";

const env = loadEnv();
if (!env.DATABASE_URL) throw new Error("DATABASE_URL not set - Gate 1.1");
if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set - Gate 1.2");
if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN not set - Gate 1.3");
if (!env.TARGET_REPO) throw new Error("TARGET_REPO not set");

const args = process.argv.slice(2);
const prArg = args.find((a) => a.startsWith("--pr"));
const prNumber = Number(prArg?.includes("=") ? prArg.split("=")[1] : args[args.indexOf("--pr") + 1]);
if (!Number.isInteger(prNumber)) throw new Error("usage: pnpm retrieve --pr <number>");

const budgetArg = args.find((a) => a.startsWith("--budget="));
const budgetTokens = budgetArg ? Number(budgetArg.split("=")[1]) : undefined;
const asJson = args.includes("--json");

const logger = createLogger(env.LOG_LEVEL, { svc: "retrieve" });
const ref = parseRepo(env.TARGET_REPO);
const gh = createClient(env.GITHUB_TOKEN);
const pool = createPool(env.DATABASE_URL);

try {
  const pr = await fetchPullRequest(gh, ref, prNumber);

  const conventions = await readConventions((path) => fetchFile(gh, ref, path, pr.headSha));
  const { rows } = await pool.query<{ path: string }>(
    "SELECT path FROM repo_files WHERE repo = $1",
    [env.TARGET_REPO],
  );
  conventions.testLayout = detectTestLayout(rows.map((r) => r.path));

  const bundle = await assembleContext({
    repo: env.TARGET_REPO,
    prNumber,
    headSha: pr.headSha,
    changedFiles: pr.files,
    pool,
    embedder: new Embedder(env.GEMINI_API_KEY),
    conventions,
    ...(budgetTokens ? { budgetTokens } : {}),
  });

  // The estimate drives budget decisions; this is the authoritative number, so
  // the estimate's error is visible rather than quietly trusted.
  const assembled = bundle.items.map((i) => `--- ${i.path}\n${i.content}`).join("\n\n");
  const actualTokens = await countTokens(env.GEMINI_API_KEY, "gemini-3.5-flash", assembled);

  if (asJson) {
    console.log(JSON.stringify({ pr, bundle, actualTokens }, null, 2));
  } else {
    render(pr, bundle, actualTokens);
  }
} finally {
  await pool.end();
}

type Bundle = Awaited<ReturnType<typeof assembleContext>>;
type Pr = Awaited<ReturnType<typeof fetchPullRequest>>;

function render(pr: Pr, bundle: Bundle, actualTokens: number): void {
  const line = "-".repeat(78);
  console.log(`\n${line}`);
  console.log(`PR #${pr.number}  ${pr.title}`);
  console.log(`by ${pr.author}  |  head ${pr.headSha.slice(0, 7)}  ->  base ${pr.baseRef}`);
  console.log(line);

  console.log("\nRETRIEVAL TRACE  (why each item is in the bundle)\n");
  const tiers = ["diff", "structural", "semantic", "conventions"] as const;
  for (const tier of tiers) {
    const items = bundle.items.filter((i) => i.tier === tier);
    if (items.length === 0) continue;
    console.log(`  ${tier.toUpperCase()}`);
    for (const item of items) {
      console.log(`    ${item.path.padEnd(30)} ${String(item.estimatedTokens).padStart(6)} tok`);
      console.log(`      ${item.reason}`);
    }
    console.log("");
  }

  if (bundle.dropped.length) {
    console.log("  DROPPED FOR BUDGET");
    for (const d of bundle.dropped) console.log(`    ${d.path.padEnd(30)} ${d.reason}`);
    console.log("");
  }

  const saving = bundle.baselineTokens
    ? (100 * (1 - actualTokens / bundle.baselineTokens)).toFixed(1)
    : "n/a";

  console.log(line);
  console.table({
    "items in bundle": bundle.items.length,
    "estimated tokens": bundle.estimatedTokens,
    "actual tokens (countTokens)": actualTokens,
    "estimate error %": `${((100 * (bundle.estimatedTokens - actualTokens)) / actualTokens).toFixed(1)}%`,
    "budget": bundle.budgetTokens,
    "naive whole-repo baseline": bundle.baselineTokens,
    "saving vs baseline": `${saving}%`,
    "structural ms": bundle.timings.structuralMs,
    "semantic ms": bundle.timings.semanticMs,
    "total ms": bundle.timings.totalMs,
  });
}
