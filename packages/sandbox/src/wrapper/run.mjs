#!/usr/bin/env node
/**
 * Runs inside the sandbox container. Executes the test command it is given and
 * prints a structured JSON envelope between sentinel markers.
 *
 * Why an envelope rather than reading the logs:
 *
 * Suite output is unbounded and interleaved. Parsing it out of a container
 * logs API works on a small example and then becomes unreliable at exactly the
 * sizes that matter - the logs API truncates, splits, and reorders under load.
 * The envelope is a fixed, small, parseable payload, and the raw output is
 * capped so a runaway test cannot flood the channel that carries the result.
 *
 * This file is plain .mjs on purpose: it must run with no build step and no
 * dependencies, because the sandbox has no network and may have nothing
 * installed but the repository's own node_modules.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const BEGIN = "<<<SRECTL_RESULT";
const END = "SRECTL_RESULT>>>";

/** Raw output cap. Enough to diagnose a failure, small enough to always ship. */
const RAW_CAP = 16_000;

/** Hard ceiling on the whole envelope, so one huge report cannot break parsing. */
const MAX_ENVELOPE = 8_000_000;

const args = process.argv.slice(2);
if (args.length === 0) {
  emit({ ok: false, error: "no command given to the wrapper" });
  process.exitCode = 2;
}

const workdir = process.env.SRECTL_WORKDIR ?? "/workspace";
const started = Date.now();

const injected = await injectFiles();

const child = spawn(args[0], args.slice(1), {
  cwd: workdir,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
let truncated = false;

function collect(chunk, which) {
  const text = chunk.toString();
  if (which === "out") {
    if (stdout.length < RAW_CAP) stdout += text;
    else truncated = true;
  } else {
    if (stderr.length < RAW_CAP) stderr += text;
    else truncated = true;
  }
}

child.stdout.on("data", (c) => collect(c, "out"));
child.stderr.on("data", (c) => collect(c, "err"));

child.on("error", (err) => {
  emit({
    ok: false,
    error: `failed to spawn: ${err.message}`,
    durationMs: Date.now() - started,
  });
  process.exitCode = 2;
});

child.on("close", async (code, signal) => {
  const durationMs = Date.now() - started;
  const results = await readVitestJson(workdir);
  const coverage = await readCoverage(workdir);
  const extra = await readExtra();

  emit({
    ok: code === 0,
    exitCode: code,
    signal: signal ?? null,
    durationMs,
    tests: results.tests,
    failures: results.failures,
    coverage,
    extra,
    injected,
    truncated,
    stdout: stdout.slice(0, RAW_CAP),
    stderr: stderr.slice(0, RAW_CAP),
  });

  process.exitCode = code ?? 1;
});

/**
 * Writes caller-supplied files into the working copy before the command runs.
 *
 * In Docker these could be written on the host before the bind mount. A
 * Kubernetes Job has no host to write to, so the files arrive as a ConfigMap
 * and are materialised here - one mechanism that works for both runners.
 *
 * The path allowlist already rejected traversal before these were sent, but
 * the code that actually touches the filesystem checks containment itself.
 */
async function injectFiles() {
  const source = process.env.SRECTL_INJECT_JSON;
  if (!source) return { count: 0, skipped: "no SRECTL_INJECT_JSON" };

  let files;
  try {
    files = JSON.parse(await readFile(source, "utf8"));
  } catch (err) {
    // Reported, never swallowed. A silent injection failure looks exactly
    // like a test suite that collected zero tests, and costs an hour.
    return { count: 0, error: `could not read ${source}: ${err.message}` };
  }
  if (!Array.isArray(files)) return { count: 0, error: "payload is not an array" };

  const root = resolve(workdir);
  let count = 0;
  const errors = [];

  for (const file of files) {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") {
      errors.push(`malformed entry: ${JSON.stringify(file).slice(0, 80)}`);
      continue;
    }
    const target = resolve(root, file.path);
    if (!target.startsWith(root + "/") && target !== root) {
      errors.push(`outside workdir: ${file.path}`);
      continue;
    }
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
      count += 1;
    } catch (err) {
      errors.push(`${file.path}: ${err.code ?? err.message}`);
    }
  }

  return { count, ...(errors.length ? { errors: errors.slice(0, 10) } : {}) };
}

/**
 * Vitest's JSON reporter is the structured source. Parsing human-readable
 * console output would break on every reporter change.
 */
async function readVitestJson(dir) {
  const empty = { tests: { total: 0, passed: 0, failed: 0, skipped: 0 }, failures: [] };
  let raw;
  try {
    raw = await readFile(join(dir, ".srectl-results.json"), "utf8");
  } catch {
    return empty;
  }

  try {
    const report = JSON.parse(raw);
    const failures = [];

    for (const suite of report.testResults ?? []) {
      for (const assertion of suite.assertionResults ?? []) {
        if (assertion.status !== "failed") continue;
        failures.push({
          name: assertion.fullName ?? assertion.title ?? "unknown",
          file: suite.name ?? null,
          message: (assertion.failureMessages ?? []).join("\n").slice(0, 2_000),
        });
      }
    }

    return {
      tests: {
        total: report.numTotalTests ?? 0,
        passed: report.numPassedTests ?? 0,
        failed: report.numFailedTests ?? 0,
        skipped: report.numPendingTests ?? 0,
      },
      failures,
    };
  } catch {
    return empty;
  }
}

async function readCoverage(dir) {
  try {
    const raw = await readFile(join(dir, "coverage", "coverage-summary.json"), "utf8");
    const summary = JSON.parse(raw);
    const total = summary.total ?? {};
    // istanbul emits the STRING "Unknown" when a metric has no data, so a
    // plain ?? null leaves a string where a number is expected.
    const pct = (v) => (typeof v === "number" ? v : null);
    return {
      lines: pct(total.lines?.pct),
      statements: pct(total.statements?.pct),
      branches: pct(total.branches?.pct),
      functions: pct(total.functions?.pct),
      // Counts, not just percentages: ranking needs "how many lines are
      // uncovered", and a percentage cannot distinguish 2 uncovered lines in
      // a tiny file from 200 in a large one.
      perFile: Object.fromEntries(
        Object.entries(summary)
          .filter(([k]) => k !== "total")
          .map(([k, v]) => [
            k,
            {
              pct: pct(v.lines?.pct),
              covered: v.lines?.covered ?? 0,
              total: v.lines?.total ?? 0,
            },
          ]),
      ),
    };
  } catch {
    return null;
  }
}

/**
 * Returns one caller-nominated JSON file inside the envelope.
 *
 * Tools like Stryker write their report to the container filesystem, which is
 * discarded when the run ends. Copying files out works in Docker and not in
 * Kubernetes, so the portable channel is the same one the results already use.
 */
async function readExtra() {
  const path = process.env.SRECTL_EXTRA_JSON;
  if (!path) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Writes the envelope and lets the process end on its own.
 *
 * process.exit() immediately after a write TRUNCATES it: stdout on a pipe is
 * asynchronous, so anything past the pipe buffer (~64KB) is discarded. A small
 * envelope survives and a large one - a mutation report, say - silently loses
 * its tail and arrives unparseable. Setting exitCode lets Node flush first.
 */
function emit(payload) {
  let body;
  try {
    body = JSON.stringify(payload);
  } catch (err) {
    body = JSON.stringify({ ok: false, error: `envelope not serializable: ${err.message}` });
  }

  // One oversized report must not cost us the whole result.
  if (body.length > MAX_ENVELOPE) {
    body = JSON.stringify({
      ...payload,
      extra: null,
      extraOmitted: `extra dropped: envelope was ${body.length} bytes, over the ${MAX_ENVELOPE} cap`,
    });
  }

  process.stdout.write("\n" + BEGIN + "\n" + body + "\n" + END + "\n");
}
