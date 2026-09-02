import { mkdir, writeFile } from "node:fs/promises";
import { runTriage } from "@srectl/agents";
import { createEmitter, createLogger, loadEnv, PgEventStore } from "@srectl/core";
import {
  applyRules,
  assessPod,
  collectTriage,
  IncidentCorrelator,
  PodWatcher,
  type Hypothesis,
  type Incident,
} from "@srectl/monitor";
import { createPool } from "@srectl/retrieval";
import { CHAOS_CASES, CHAOS_NS } from "../eval/chaos/cases.js";
import { scoreIncident, summarize, type ScoredIncident } from "../eval/chaos/score.js";

/**
 * Watches the seeded failures, triages each incident, and scores the result
 * against ground truth.
 *
 * The number that matters is not "did it notice something broke" - Kubernetes
 * already says that. It is whether the ranked cause is the one we planted.
 */

const env = loadEnv();
const logger = createLogger("warn", { svc: "eval-chaos" });
const WATCH_SECONDS = Number(process.argv.find((a) => a.startsWith("--watch="))?.split("=")[1] ?? 45);

const pool = createPool(env.DATABASE_URL!);
const emit = createEmitter(new PgEventStore(pool), logger);

const correlator = new IncidentCorrelator();
const incidents = new Map<string, Incident & { exitCode: number | null }>();
const firstObserved = new Map<string, number>();

const watcher = new PodWatcher({
  namespaces: [CHAOS_NS],
  logger,
  onPod: ({ pod, at }) => {
    const health = assessPod(pod);
    const incident = correlator.observe(pod, health, at);
    if (!incident) return;

    incidents.set(incident.podName, { ...incident, exitCode: health.exitCode });
    if (!firstObserved.has(incident.podName)) {
      firstObserved.set(incident.podName, Date.now());
    }
  },
});

console.log(`watching ${CHAOS_NS} for ${WATCH_SECONDS}s...`);
void watcher.start();

await new Promise((resolve) => setTimeout(resolve, WATCH_SECONDS * 1000));
watcher.stop();

console.log(
  `\ndetected ${incidents.size} incident(s) from ${CHAOS_CASES.length} seeded faults ` +
    `(watch restarts: ${watcher.stats.restarts}, relists: ${watcher.stats.relists})\n`,
);

const scored: ScoredIncident[] = [];
const rows: Array<Record<string, unknown>> = [];
let modelCalls = 0;

for (const testCase of CHAOS_CASES) {
  const incident = incidents.get(testCase.name);
  if (!incident) {
    rows.push({ case: testCase.name, expected: testCase.faultClass, detected: "NOT DETECTED", top1: "-", ok: "MISS", source: "-" });
    scored.push({
      case: testCase.name,
      expected: testCase.faultClass,
      top1: "unknown",
      top1Correct: false,
      top3Correct: false,
      confidence: "none",
      source: "none",
      evidenceCount: 0,
      detectionLatencyMs: null,
    });
    continue;
  }

  await emit({
    type: "incident.opened",
    correlationId: incident.id,
    incidentId: incident.id,
    namespace: incident.namespace,
    podName: incident.podName,
    workload: incident.workload,
    signal: incident.signal,
    restartCount: incident.restartCount,
  });

  const triageStarted = performance.now();
  const bundle = await collectTriage(incident);

  // Rules first. Everything they answer costs no tokens and no latency.
  const ruled = applyRules(bundle);
  let hypotheses: Hypothesis[] = ruled.hypotheses;

  let modelFailure: string | undefined;
  if (!ruled.conclusive) {
    modelCalls += 1;
    const triage = await runTriage({ apiKey: env.GEMINI_API_KEY!, bundle, logger });
    hypotheses = [...hypotheses, ...triage.hypotheses];
    // An unavailable model is not the same as a wrong answer, and scoring it
    // as "unknown" quietly blames the agent for an upstream outage.
    if (triage.failure) modelFailure = triage.failure;
  }

  const latency = firstObserved.get(testCase.name);
  const result = scoreIncident({
    caseName: testCase.name,
    expected: testCase.faultClass,
    hypotheses,
    detectionLatencyMs: latency ? latency - Date.parse(incident.firstSeen) : null,
    unavailable: hypotheses.length === 0 ? modelFailure : undefined,
  });
  const top = hypotheses[0];
  await emit({
    type: "incident.triaged",
    correlationId: incident.id,
    incidentId: incident.id,
    topCause: (top?.cause ?? "no hypothesis").slice(0, 500),
    confidence: top?.confidence ?? "none",
    // Recording WHICH layer answered is what makes the restraint visible: a
    // system that quietly called the model every time would look identical.
    source: top?.source ?? "rule",
    ruleName: ruled.rule,
    hypotheses: hypotheses.length,
    evidenceCount: top?.evidence.length ?? 0,
    durationMs: Math.round(performance.now() - triageStarted),
  });

  scored.push(result);

  rows.push({
    case: testCase.name,
    expected: testCase.faultClass,
    detected: incident.signal,
    top1: result.top1,
    ok: result.unavailable ? "UNAVAILABLE" : result.top1Correct ? "OK" : "WRONG",
    source: result.source,
    conf: result.confidence,
    evidence: result.evidenceCount,
    ...(modelFailure ? { note: modelFailure.slice(0, 40) } : {}),
  });
}

console.table(rows);

const summary = summarize(scored);
console.log("\nSUMMARY");
console.table({
  "seeded faults": CHAOS_CASES.length,
  "incidents opened": incidents.size,
  "cases scored": summary.scorable,
  "cases unscorable (model unavailable)": summary.unavailable,
  "top-1 accuracy": `${summary.top1}/${summary.total} (${summary.top1Pct}%)`,
  "top-3 accuracy": `${summary.top3}/${summary.total} (${summary.top3Pct}%)`,
  "answered by rules (no model call)": summary.byRule,
  "answered by model": summary.byModel,
  "model calls made": modelCalls,
});

await mkdir("eval/results", { recursive: true });
await writeFile(
  "eval/results/monitor.json",
  JSON.stringify({ ts: new Date().toISOString(), summary, scored }, null, 2),
);
console.log("\nmetrics written to eval/results/monitor.json");

process.exitCode = summary.top1Pct >= 80 ? 0 : 1;
