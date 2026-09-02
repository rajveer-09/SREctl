import Bar from "../bar";
import { loadSummary, pick } from "@/lib/queries";
import { compact, Empty, Panel, RelTime, Tag } from "../ui";

export const dynamic = "force-dynamic";

const TIER_VAR: Record<string, string> = {
  diff: "var(--t-diff)",
  structural: "var(--t-structural)",
  semantic: "var(--t-semantic)",
  conventions: "var(--t-conventions)",
};

export default async function Page() {
  const { latest } = await loadSummary(400);
  const traces = pick(latest, "retrieval.completed");
  const reviews = pick(latest, "review.completed");

  const structuralHits = traces.reduce(
    (s, t) => s + t.items.filter((i) => i.tier === "structural").length,
    0,
  );

  return (
    <>
      <Bar crumb="evidence" title="Retrieval" meta={`${traces.length} traces`} />

      <div className="page">
        <p className="lede">
          Why each file entered the context bundle. <b>Structural</b> neighbours come from a real
          import graph, which is how a caller three directories away gets found — embedding
          similarity would not surface it, because it shares no vocabulary with the change.
        </p>

        {traces.length === 0 ? (
          <Panel title="Traces">
            <Empty>
              No retrievals recorded. Run <code>pnpm review --pr N</code>.
            </Empty>
          </Panel>
        ) : null}

        {traces.map((trace) => {
          const review = reviews.find((r) => r.prNumber === trace.prNumber);
          const widest = Math.max(1, ...trace.items.map((i) => i.tokens));
          const saving = trace.baselineTokens
            ? 100 * (1 - trace.estimatedTokens / trace.baselineTokens)
            : null;

          const perTier = new Map<string, number>();
          for (const item of trace.items) {
            perTier.set(item.tier, (perTier.get(item.tier) ?? 0) + item.tokens);
          }

          return (
            <Panel
              key={trace.id}
              title={`PR #${trace.prNumber}`}
              aside={
                <>
                  {trace.items.length} items · {compact(trace.estimatedTokens)} tok
                  {saving !== null ? ` · ${saving.toFixed(0)}% under whole-repo` : ""}
                  {review ? ` · ${review.findings} finding${review.findings === 1 ? "" : "s"}` : ""}
                  {" · "}
                  <RelTime iso={trace.ts} />
                </>
              }
            >
              <div className="pad" style={{ display: "flex", gap: 6, flexWrap: "wrap", borderBottom: "1px solid var(--line)" }}>
                {["diff", "structural", "semantic", "conventions"].map((tier) =>
                  perTier.has(tier) ? (
                    <Tag key={tier} tone={tier as "diff"} solid>
                      {tier} · {perTier.get(tier)} tok
                    </Tag>
                  ) : null,
                )}
                <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--dim)" }}>
                  structural {trace.structuralMs}ms · semantic {trace.semanticMs}ms
                </span>
              </div>

              <div className="trace">
                {trace.items.map((item, i) => (
                  <div className="tr" key={`${trace.id}-${i}`}>
                    <Tag tone={item.tier as "diff"}>{item.tier}</Tag>
                    <span>
                      <span className="path">{item.path}</span>
                      <br />
                      <span className="why">{item.reason}</span>
                    </span>
                    {/* Weight, not just a count: which file is eating the
                        budget is the question this view has to answer. */}
                    <span className="weight">
                      <span
                        style={{
                          width: `${(item.tokens / widest) * 100}%`,
                          background: TIER_VAR[item.tier] ?? "var(--dim)",
                        }}
                      />
                    </span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 11, textAlign: "right", color: "var(--dim)" }}>
                      {item.tokens}
                    </span>
                  </div>
                ))}

                {trace.dropped.map((d, i) => (
                  <div className="tr dropped" key={`${trace.id}-d-${i}`}>
                    <Tag tone="warn">dropped</Tag>
                    <span>
                      <span className="path">{d.path}</span>
                      <br />
                      <span className="why">excluded by the token budget</span>
                    </span>
                    <span className="weight" />
                    <span style={{ fontFamily: "var(--mono)", fontSize: 11, textAlign: "right", color: "var(--dim)" }}>
                      {d.tokens}
                    </span>
                  </div>
                ))}
              </div>
            </Panel>
          );
        })}

        {traces.length > 0 ? (
          <p className="lede" style={{ fontSize: 12 }}>
            {structuralHits} file{structuralHits === 1 ? "" : "s"} across these traces were included
            solely because of an import edge.
          </p>
        ) : null}
      </div>
    </>
  );
}
