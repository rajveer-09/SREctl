import type { Envelope, ParseFailure } from "./envelope.js";

/**
 * The execution contract, shaped for Kubernetes rather than for Docker.
 *
 * This is the load-bearing decision of Phase 2. Docker could express all of
 * this as one call with a pile of flags, but Kubernetes cannot: "no network"
 * and "npm install" are in direct conflict, so they must be separate Jobs with
 * separate NetworkPolicies. Modelling that split now - prepare() producing an
 * artifact that exec() consumes, deadlines passed in rather than assumed,
 * results returned as a parsed envelope rather than a log stream - makes
 * Phase 3 an implementation of this interface instead of a rewrite of its
 * callers.
 */

export interface PrepSpec {
  /** Host path to the repository whose dependencies are being installed. */
  repoRoot: string;
  /**
   * Cache key. Dependencies change far less often than code, so most runs
   * should skip this phase entirely.
   */
  lockfileHash: string;
  timeoutSeconds: number;
}

export interface PrepResult {
  /** Opaque handle exec() uses to attach the installed dependencies. */
  artifactRef: string;
  cacheHit: boolean;
  durationMs: number;
  /** Present when the install itself failed. */
  error?: string;
}

export interface InjectedFile {
  /** Repo-relative POSIX path. Validated against the allowlist by the caller. */
  path: string;
  content: string;
}

export interface ExecSpec {
  artifactRef: string;
  repoRoot: string;
  /** Generated files written into the working copy before the command runs. */
  files: InjectedFile[];
  command: string[];
  /**
   * Wall-clock ceiling. 120s for the generate-and-repair loop, 600s for
   * mutation runs: different work, different budgets.
   */
  timeoutSeconds: number;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  /**
   * Absolute in-container path of a JSON file to return in the envelope.
   * The portable way to retrieve a tool's report: copying files out of a
   * container works in Docker and does not translate to a finished Job.
   */
  extraJsonPath?: string;
}

export interface ExecResult {
  envelope: Envelope | null;
  /** Set when output arrived but could not be parsed into an envelope. */
  parseFailure?: { reason: ParseFailure; detail: string };
  exitCode: number | null;
  timedOut: boolean;
  oomKilled: boolean;
  durationMs: number;
  /** Bounded tail of raw output, for diagnosing a run with no envelope. */
  rawTail: string;
}

export interface SandboxRunner {
  readonly kind: "docker" | "k8s";
  prepare(spec: PrepSpec): Promise<PrepResult>;
  exec(spec: ExecSpec): Promise<ExecResult>;
  /** Releases anything the runner created that is not cache. */
  cleanup(): Promise<void>;
}

export interface Budget {
  timeoutSeconds: number;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
}

/**
 * Budgets named once, so the two Job classes stay distinguishable. Mutation
 * runs the suite once per mutant, so it needs a different order of magnitude
 * of wall clock than the generate-and-repair loop.
 */
export const BUDGETS: Record<"test" | "mutation", Budget> = {
  test: { timeoutSeconds: 120, memoryMb: 1024, cpus: 2, pidsLimit: 256 },
  mutation: { timeoutSeconds: 600, memoryMb: 2048, cpus: 2, pidsLimit: 512 },
};
