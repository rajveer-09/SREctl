import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Logger } from "@srectl/core";
import { parseEnvelope } from "./envelope.js";
import type { ExecResult, ExecSpec, PrepResult, PrepSpec, SandboxRunner } from "./runner.js";
import { runnerImage } from "./image.js";

const IMAGE = runnerImage();

/**
 * Docker implementation of the two-phase model.
 *
 * Phase A (prepare) has network and installs into a named volume keyed by the
 * lockfile hash. No untrusted code runs: install scripts are disabled, so no
 * package postinstall executes while the network is up.
 *
 * Phase B (exec) has no network at all. It runs against a throwaway copy of
 * the repository with the dependency volume attached read-only.
 */
export class DockerRunner implements SandboxRunner {
  readonly kind = "docker" as const;
  private readonly scratch: string[] = [];

  constructor(private readonly logger?: Logger) {}

  async prepare(spec: PrepSpec): Promise<PrepResult> {
    const started = performance.now();
    const volume = `srectl-deps-${spec.lockfileHash.slice(0, 16)}`;

    if (await volumeExists(volume)) {
      this.logger?.info("prep cache hit", { volume });
      return { artifactRef: volume, cacheHit: true, durationMs: Math.round(performance.now() - started) };
    }

    this.logger?.info("prep cache miss, installing", { volume });
    await run("docker", ["volume", "create", volume], 30);

    // A fresh named volume is root-owned, so uid 10001 cannot write to it.
    // One short root container fixes ownership and does nothing else; the
    // install that follows stays unprivileged. In Phase 3 this is expressed
    // declaratively as fsGroup on the PVC rather than as a chown step.
    await run(
      "docker",
      [
        "run", "--rm",
        "--user", "0:0",
        "-v", `${volume}:/deps`,
        "--entrypoint", "chown",
        IMAGE,
        "10001:10001", "/deps",
      ],
      60,
    );

    // --ignore-scripts is the reason this phase is allowed network access at
    // all: a package postinstall would otherwise run arbitrary code with both
    // the network and the dependency tree in front of it.
    const install = await run(
      "docker",
      [
        "run", "--rm",
        "--user", "10001:10001",
        "-v", `${toDockerPath(spec.repoRoot)}:/src:ro`,
        "-v", `${volume}:/deps`,
        // mode=1777 and NOT using -w here: Docker creates a --workdir as root
        // before dropping to the container user, so /tmp/install would end up
        // owned by root on a tmpfs and unwritable by uid 10001.
        "--tmpfs", "/tmp:exec,mode=1777",
        "--tmpfs", "/home/runner:mode=0777",
        "--entrypoint", "sh",
        IMAGE,
        "-c",
        // Only the manifests are copied in, never the source. Redirection
        // rather than `cp`: /src is a read-only mount, and cp preserves the
        // read-only mode, so npm then fails with EACCES writing the lockfile.
        "set -e; mkdir -p /tmp/install; cd /tmp/install; " +
          "cat /src/package.json > package.json; " +
          "if [ -f /src/package-lock.json ]; then cat /src/package-lock.json > package-lock.json; fi; " +
          "if [ -f package-lock.json ]; then npm ci --ignore-scripts --no-audit --no-fund; " +
          "else npm install --ignore-scripts --no-audit --no-fund; fi; " +
          "cp -R /tmp/install/node_modules/. /deps/",
      ],
      spec.timeoutSeconds,
    );

    if (install.code !== 0) {
      await run("docker", ["volume", "rm", "-f", volume], 30).catch(() => undefined);
      return {
        artifactRef: volume,
        cacheHit: false,
        durationMs: Math.round(performance.now() - started),
        error: `npm ci failed (exit ${install.code}): ${install.stderr.slice(-1500)}`,
      };
    }

    return { artifactRef: volume, cacheHit: false, durationMs: Math.round(performance.now() - started) };
  }

  async exec(spec: ExecSpec): Promise<ExecResult> {
    const started = performance.now();

    // Work on a throwaway copy. Generated code never touches the real
    // checkout, so an abandoned attempt leaves nothing behind to clean up.
    const workdir = await mkdtemp(join(tmpdir(), "srectl-exec-"));
    this.scratch.push(workdir);

    await cp(spec.repoRoot, workdir, {
      recursive: true,
      filter: (src) => !src.includes("node_modules") && !src.includes(`${".git"}`),
    });

    for (const file of spec.files) {
      const target = resolve(workdir, file.path);
      // Defence in depth: the allowlist already rejected traversal, but the
      // thing that actually writes to disk checks containment itself.
      if (!target.startsWith(resolve(workdir))) {
        throw new Error(`refusing to write outside the working copy: ${file.path}`);
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
    }

    // Not --rm: the container has to survive long enough to be inspected.
    // Exit code alone cannot distinguish an OOM from an ordinary failure -
    // Node reads the cgroup limit, hits its own heap ceiling first, and exits
    // 1 with "JavaScript heap out of memory" rather than being SIGKILLed to
    // 137. Only the daemon knows whether the OOM killer fired.
    const containerName = `srectl-exec-${randomUUID().slice(0, 12)}`;

    const result = await run(
      "docker",
      [
        "run",
        "--name", containerName,
        "--network=none",
        "--read-only",
        "--user", "10001:10001",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--memory", `${spec.memoryMb}m`,
        "--memory-swap", `${spec.memoryMb}m`,
        "--cpus", String(spec.cpus),
        "--pids-limit", String(spec.pidsLimit),
        "-v", `${toDockerPath(workdir)}:/workspace`,
        "-v", `${spec.artifactRef}:/workspace/node_modules:ro`,
        // Modes are explicit. A bare --tmpfs mounts 0755 root-owned, so uid
        // 10001 gets EACCES on $HOME - which surfaces later as an unrelated
        // npm or vitest failure rather than as a permissions problem.
        "--tmpfs", "/tmp:exec,mode=1777",
        "--tmpfs", "/home/runner:exec,mode=1777",
        "-e", "SRECTL_WORKDIR=/workspace",
        ...(spec.extraJsonPath ? ["-e", `SRECTL_EXTRA_JSON=${spec.extraJsonPath}`] : []),
        IMAGE,
        ...spec.command,
      ],
      spec.timeoutSeconds,
    );

    const state = await inspectState(containerName);
    await run("docker", ["rm", "-f", containerName], 30).catch(() => undefined);

    const raw = result.stdout + "\n" + result.stderr;
    const parsed = parseEnvelope(raw);

    return {
      envelope: parsed.ok ? parsed.envelope : null,
      ...(parsed.ok ? {} : { parseFailure: { reason: parsed.reason, detail: parsed.detail } }),
      exitCode: state?.exitCode ?? result.code,
      timedOut: result.timedOut,
      // Authoritative: the daemon's own record of whether the OOM killer fired.
      // Falls back to 137 only when the container could not be inspected.
      oomKilled: state ? state.oomKilled : result.code === 137 && !result.timedOut,
      durationMs: Math.round(performance.now() - started),
      rawTail: raw.slice(-4000),
    };
  }

  async cleanup(): Promise<void> {
    await Promise.all(this.scratch.map((dir) => rm(dir, { recursive: true, force: true })));
    this.scratch.length = 0;
  }
}

interface RunOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Spawned without a shell, deliberately. Passing an argv array avoids both
 * shell injection and MSYS path mangling, which would otherwise rewrite
 * "/workspace" into a Windows path on Git Bash.
 */
function run(command: string, args: string[], timeoutSeconds: number): Promise<RunOutcome> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { shell: false });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutSeconds * 1000);

    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr: stderr + String(err), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut });
    });
  });
}

/**
 * The daemon's record of how a container ended. This is the only reliable
 * source for OOMKilled: a process that hits its own runtime heap ceiling under
 * a cgroup limit exits normally and never shows up as 137.
 */
async function inspectState(name: string): Promise<{ exitCode: number; oomKilled: boolean } | null> {
  const result = await run(
    "docker",
    ["inspect", "--format", "{{.State.ExitCode}} {{.State.OOMKilled}}", name],
    20,
  );
  if (result.code !== 0) return null;

  const [code, oom] = result.stdout.trim().split(/\s+/);
  if (code === undefined) return null;
  return { exitCode: Number(code), oomKilled: oom === "true" };
}

async function volumeExists(name: string): Promise<boolean> {
  const result = await run("docker", ["volume", "inspect", name], 15);
  return result.code === 0;
}

/** Docker Desktop accepts Windows paths with forward slashes. */
function toDockerPath(path: string): string {
  return path.split("\\").join("/");
}
