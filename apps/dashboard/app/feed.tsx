"use client";

import { RelTime } from "./ui";
import { useStream, type SrectlEvent } from "./use-stream";

type Severity = "ok" | "warn" | "bad" | "accent" | "";

/**
 * One line of prose per event type, plus a severity.
 *
 * The severity drives a 4px rail rather than the text colour: an operator
 * scanning the stream needs to find the red line without reading it, and
 * colouring whole rows turns every event into a status.
 */
function render(e: SrectlEvent): { detail: string; aside: string; severity: Severity } {
  const n = (k: string) => (typeof e[k] === "number" ? (e[k] as number) : undefined);
  const s = (k: string) => (typeof e[k] === "string" ? (e[k] as string) : undefined);
  const ms = (k: string) => {
    const v = n(k);
    return v === undefined ? "" : v < 10 ? `${v.toFixed(2)}ms` : `${Math.round(v)}ms`;
  };

  switch (e.type) {
    case "webhook.received":
      return {
        detail: `${s("githubEvent")}${s("action") ? `.${s("action")}` : ""} — ${s("repo") ?? ""}`,
        aside: ms("handlingMs"),
        severity: "",
      };
    case "webhook.duplicate":
      return { detail: `redelivery ignored — ${s("githubEvent")}`, aside: ms("handlingMs"), severity: "warn" };
    case "webhook.rejected":
      return { detail: `rejected — ${s("reason")}`, aside: ms("handlingMs"), severity: "bad" };
    case "webhook.ignored":
      return { detail: `not reviewable — ${s("githubEvent")}.${s("action") ?? ""}`, aside: "", severity: "" };
    case "job.enqueued":
      return { detail: `queued ${s("kind")} — ${s("repo")}`, aside: "", severity: "accent" };

    case "retrieval.completed": {
      const items = Array.isArray(e["items"]) ? (e["items"] as unknown[]).length : 0;
      return {
        detail: `assembled ${items} context items — PR #${n("prNumber")}`,
        aside: `${n("estimatedTokens")} tok · ${ms("totalMs")}`,
        severity: "accent",
      };
    }
    case "review.completed": {
      const findings = n("findings") ?? 0;
      return {
        detail: `PR #${n("prNumber")} — ${findings} finding${findings === 1 ? "" : "s"}${e["posted"] ? ", posted" : ", dry run"}`,
        aside: `${(e["usage"] as { model?: string } | undefined)?.model ?? ""} · ${ms("latencyMs")}`,
        severity: findings > 0 ? "warn" : "ok",
      };
    }
    case "review.failed":
      return { detail: `PR #${n("prNumber")} — ${s("reason")?.slice(0, 70)}`, aside: `${n("attempts")} attempts`, severity: "bad" };

    case "testgen.started":
      return {
        detail: `target ${s("target")} — ${n("uncoveredLines")} uncovered, ${n("importers")} importers`,
        aside: s("runner") ?? "",
        severity: "accent",
      };
    case "testgen.attempt": {
      const outcome = s("outcome") ?? "";
      return {
        detail: `attempt ${n("attempt")} — ${s("target")} — ${outcome}`,
        aside: ms("durationMs"),
        severity: outcome === "passed" ? "ok" : outcome === "upstream-error" ? "warn" : "bad",
      };
    }
    case "testgen.mutation":
      return {
        detail: `mutation ${s("target")} — ${n("score") ?? "n/a"}% (${n("killed")} killed, ${n("survived")} survived)`,
        aside: e["cleared"] ? "cleared" : "below threshold",
        severity: e["cleared"] ? "ok" : "bad",
      };
    case "testgen.completed":
      return {
        detail: `${s("target")} — ${e["accepted"] ? "accepted" : "discarded"}: ${s("reason")}`,
        aside: `${n("attempts")} attempt(s)`,
        severity: e["accepted"] ? "ok" : "warn",
      };

    case "sandbox.exec":
      return { detail: `${s("runner")} — ${s("purpose")}`, aside: ms("durationMs"), severity: "" };

    case "incident.opened":
      return {
        detail: `${s("signal")} — ${s("namespace")}/${s("podName")}`,
        aside: `${n("restartCount")} restarts`,
        severity: "bad",
      };
    case "incident.triaged":
      return {
        detail: s("topCause")?.slice(0, 120) ?? "triaged",
        aside: `${s("source")} · ${s("confidence")}`,
        severity: s("source") === "rule" ? "ok" : "accent",
      };
    case "incident.resolved":
      return { detail: `resolved — ${s("incidentId")}`, aside: "", severity: "ok" };

    default:
      return { detail: e.type, aside: "", severity: "" };
  }
}

export default function Feed({ initial }: { initial: SrectlEvent[] }) {
  const { events } = useStream();

  // Live first, then server-rendered history, deduplicated by id.
  const seen = new Set<string>();
  const merged = [...events, ...initial].filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });

  if (merged.length === 0) {
    return (
      <div className="empty">
        Nothing has happened yet. Run <code>pnpm review --pr N</code>,{" "}
        <code>pnpm testgen</code>, or <code>pnpm eval:chaos</code>.
      </div>
    );
  }

  return (
    <div className="stream">
      {merged.slice(0, 250).map((e, i) => {
        const { detail, aside, severity } = render(e);
        return (
          <div
            key={e.id}
            className={`ev${severity ? ` s-${severity}` : ""}${i < events.length ? " new" : ""}`}
          >
            <RelTime iso={e.ts} />
            <span className="rail-mark" />
            <span className="ty">{e.type}</span>
            <span className="detail" title={detail}>
              {detail}
            </span>
            <span className="aside">{aside}</span>
          </div>
        );
      })}
    </div>
  );
}
