import Bar from "../bar";
import { loadSummary, pick } from "@/lib/queries";
import { Empty, Panel, RelTime, Stat, Tag } from "../ui";

export const dynamic = "force-dynamic";

/** Severity of a Kubernetes signal, for the row rail. */
function tone(signal: string): "bad" | "warn" {
  return signal === "OOMKilled" || signal === "ImagePullBackOff" || signal === "CrashLoopBackOff"
    ? "bad"
    : "warn";
}

export default async function Page() {
  const { latest } = await loadSummary(500);
  const opened = pick(latest, "incident.opened");
  const triaged = pick(latest, "incident.triaged");

  const byRule = triaged.filter((t) => t.source === "rule").length;
  const byModel = triaged.filter((t) => t.source === "model").length;

  const signals = new Map<string, number>();
  for (const o of opened) signals.set(o.signal, (signals.get(o.signal) ?? 0) + 1);
  const widest = Math.max(1, ...signals.values());

  const noHypothesis = triaged.filter((t) => t.topCause === "no hypothesis").length;

  return (
    <>
      <Bar crumb="observe" title="Cluster" meta={`${opened.length} incidents`} />

      <div className="page">
        <p className="lede">
          The agent <b>hypothesizes; it does not diagnose</b>. Every row is a likely cause with cited
          evidence and a confidence level — never a root cause, because it reasons from a snapshot it
          did not watch being created.
        </p>

        <div className="stats">
          <Stat k="incidents" v={opened.length} tone={opened.length > 0 ? "attn" : undefined} />
          <Stat k="by rules" v={byRule} note="zero model calls" tone="good" />
          <Stat k="by model" v={byModel} note="ambiguous only" />
          <Stat k="signals" v={signals.size} note={[...signals.keys()].slice(0, 2).join(", ")} />
          {noHypothesis > 0 ? (
            <Stat k="unresolved" v={noHypothesis} note="triage produced nothing" tone="bad" />
          ) : null}
        </div>

        {signals.size > 0 ? (
          <Panel title="Signal distribution" aside="what is failing, by kind">
            <div className="pad rows">
              {[...signals.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([signal, n]) => (
                  <div className="row2" key={signal}>
                    <span className="label">{signal}</span>
                    <span className={`track${tone(signal) === "bad" ? "" : " warn"}`}>
                      <span style={{ width: `${(n / widest) * 100}%` }} />
                    </span>
                    <span className="val">{n}</span>
                  </div>
                ))}
            </div>
          </Panel>
        ) : null}

        <Panel title="Incidents and hypotheses" aside={`${opened.length}`} scroll>
          {opened.length === 0 ? (
            <Empty>
              No incidents. Run <code>pnpm chaos:up</code> then <code>pnpm eval:chaos</code>.
            </Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>pod</th>
                  <th>signal</th>
                  <th className="num">restarts</th>
                  <th>likely cause</th>
                  <th>answered by</th>
                  <th className="num">evidence</th>
                  <th className="num">seen</th>
                </tr>
              </thead>
              <tbody>
                {opened.map((incident) => {
                  const t = triaged.find((x) => x.incidentId === incident.incidentId);
                  const unresolved = !t || t.topCause === "no hypothesis";
                  return (
                    <tr key={incident.id}>
                      <td className="mono">{incident.podName}</td>
                      <td>
                        <Tag tone={tone(incident.signal)} solid>
                          {incident.signal}
                        </Tag>
                      </td>
                      <td className="num">{incident.restartCount}</td>
                      <td className={`note${unresolved ? " dim" : ""}`}>
                        {t?.topCause ?? "—"}
                      </td>
                      <td>
                        {t ? (
                          <Tag tone={t.source === "rule" ? "ok" : "accent"}>
                            {t.source}
                            {t.ruleName ? `:${t.ruleName}` : ""}
                          </Tag>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="num">{t?.evidenceCount ?? 0}</td>
                      <td className="num">
                        <RelTime iso={incident.ts} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </>
  );
}
