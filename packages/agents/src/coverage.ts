import type { Envelope } from "@srectl/sandbox";
import type pg from "pg";

export interface TargetCandidate {
  path: string;
  linePct: number;
  coveredLines: number;
  totalLines: number;
  uncoveredLines: number;
  /** How many files import this one, from the real import graph. */
  importers: number;
  score: number;
  reason: string;
}

/** Files that are not worth generating tests for. */
const EXCLUDE = [
  /\.(test|spec)\.[cm]?[jt]sx?$/, // tests do not need tests
  /(^|\/)index\.[cm]?[jt]s$/, // barrels have no logic
  /\.d\.ts$/,
];

/**
 * Coverage paths come back from inside the container. Normalize them to the
 * repo-relative form the import graph is keyed on, or centrality lookups
 * silently return zero for every file.
 */
export function normalizeCoveragePath(raw: string, workdir = "/workspace"): string {
  let path = raw.split("\\").join("/");
  if (path.startsWith(workdir)) path = path.slice(workdir.length);
  return path.replace(/^\/+/, "");
}

/**
 * Ranks files by how much untested logic they carry AND how much depends on
 * them.
 *
 * Uncovered lines alone would rank a large unused file above a small one that
 * half the repository imports. Weighting by importer count is what makes the
 * import graph pay for itself twice: once for retrieval, once for choosing
 * where a test is worth writing.
 */
export async function rankTargets(opts: {
  repo: string;
  pool: pg.Pool;
  coverage: NonNullable<Envelope["coverage"]>;
  limit?: number;
}): Promise<TargetCandidate[]> {
  const perFile = opts.coverage.perFile ?? {};

  const { rows } = await opts.pool.query<{ to_path: string; importers: string }>(
    `SELECT to_path, count(*)::text AS importers
       FROM import_edges WHERE repo = $1 GROUP BY to_path`,
    [opts.repo],
  );
  const centrality = new Map(rows.map((r) => [r.to_path, Number(r.importers)]));

  const candidates: TargetCandidate[] = [];

  for (const [rawPath, stats] of Object.entries(perFile)) {
    const path = normalizeCoveragePath(rawPath);
    if (EXCLUDE.some((re) => re.test(path))) continue;

    const uncoveredLines = Math.max(0, stats.total - stats.covered);
    if (uncoveredLines === 0) continue;

    const importers = centrality.get(path) ?? 0;

    // Importers are a multiplier rather than an addend, so a widely-imported
    // file with a few uncovered lines can still outrank an isolated one with
    // many. +1 keeps leaf files in the running instead of zeroing them.
    const score = uncoveredLines * (1 + importers);

    candidates.push({
      path,
      linePct: stats.pct ?? 0,
      coveredLines: stats.covered,
      totalLines: stats.total,
      uncoveredLines,
      importers,
      score,
      reason:
        importers > 0
          ? `${uncoveredLines} uncovered line(s), imported by ${importers} file(s)`
          : `${uncoveredLines} uncovered line(s), no importers`,
    });
  }

  candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return opts.limit ? candidates.slice(0, opts.limit) : candidates;
}

/** Coverage delta for the PR body, in percentage points. */
export function coverageDelta(
  before: NonNullable<Envelope["coverage"]>,
  after: NonNullable<Envelope["coverage"]>,
  path: string,
): { fileBefore: number; fileAfter: number; totalBefore: number; totalAfter: number } {
  const find = (cov: NonNullable<Envelope["coverage"]>) => {
    for (const [raw, stats] of Object.entries(cov.perFile ?? {})) {
      if (normalizeCoveragePath(raw) === path) return stats.pct ?? 0;
    }
    return 0;
  };

  return {
    fileBefore: find(before),
    fileAfter: find(after),
    totalBefore: before.lines ?? 0,
    totalAfter: after.lines ?? 0,
  };
}
