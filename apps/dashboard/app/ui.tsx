import type { ReactNode } from "react";

/** Shared primitives, so six pages cannot each invent their own spacing. */

export function Panel({
  title,
  aside,
  children,
  scroll,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  scroll?: boolean;
}) {
  return (
    <section className="panel">
      <header>
        <h2>{title}</h2>
        {aside ? <span className="aside">{aside}</span> : null}
      </header>
      <div className={scroll ? "scroll" : undefined}>{children}</div>
    </section>
  );
}

export function Stat({
  k,
  v,
  note,
  tone,
}: {
  k: string;
  v: ReactNode;
  note?: ReactNode;
  tone?: "good" | "attn" | "bad";
}) {
  return (
    <div className={`stat${tone ? ` ${tone}` : ""}`}>
      <span className="k">{k}</span>
      <span className="v">{v}</span>
      {note ? <span className="n">{note}</span> : null}
    </div>
  );
}

/**
 * An empty state that says what to run.
 *
 * "No data yet" tells an operator nothing. The command that produces the data
 * is the only useful thing to put here.
 */
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Tag({
  tone = "mute",
  solid,
  children,
}: {
  tone?: "ok" | "warn" | "bad" | "info" | "mute" | "accent" | "diff" | "structural" | "semantic" | "conventions";
  solid?: boolean;
  children: ReactNode;
}) {
  return <span className={`tag ${tone}${solid ? " solid" : ""}`}>{children}</span>;
}

/**
 * Relative time in the label, absolute in the tooltip.
 *
 * "2m ago" is what you read while scanning; the exact timestamp is what you
 * need the moment something looks wrong, and losing it costs a correlation.
 */
export function RelTime({ iso }: { iso: string }) {
  const then = new Date(iso);
  const seconds = Math.max(0, Math.round((Date.now() - then.getTime()) / 1000));

  const label =
    seconds < 60
      ? `${seconds}s`
      : seconds < 3600
        ? `${Math.round(seconds / 60)}m`
        : seconds < 86_400
          ? `${Math.round(seconds / 3600)}h`
          : `${Math.round(seconds / 86_400)}d`;

  return (
    <span className="rel" title={then.toISOString()}>
      {label}
    </span>
  );
}

export function num(n: number): string {
  return n.toLocaleString("en-US");
}

/** Compact token counts: 10,582 reads as 10.6k in a dense column. */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
