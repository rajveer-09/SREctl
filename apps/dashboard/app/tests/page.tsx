import Bar from "../bar";
import { loadSummary, pick } from "@/lib/queries";
import { compact, Empty, Panel, RelTime, Stat, Tag } from "../ui";

export const dynamic = "force-dynamic";

export default async function Page() {
  const { latest } = await loadSummary(500);
  const started = pick(latest, "testgen.started");
  const attempts = pick(latest, "testgen.attempt");
  const mutations = pick(latest, "testgen.mutation");
  const completed = pick(latest, "testgen.completed");

  /**
   * An outage is not a stage of the funnel.
   *
   * `upstream-error` means the model API was unavailable, so nothing was
   * generated, compiled or run. Counting those made "compiled: 2" appear for
   * two runs where no test file ever existed. Every stage below is a POSITIVE
   * filter on outcomes that actually reached it.
   */
  const outages = attempts.filter((a) => a.outcome === "upstream-error");
  const real = attempts.filter((a) => a.outcome !== "upstream-error");

  const RAN = new Set(["passed", "failed", "timeout", "oom"]);
  const compiled = real.filter((a) => RAN.has(a.outcome));
  const passed = real.filter((a) => a.outcome === "passed");
  const cleared = mutations.filter((m) => m.cleared);
  const proposed = completed.filter((c) => c.accepted);

  const stages = [
    { label: "generated", n: real.length, note: "the model returned a test file" },
    { label: "compiled + ran", n: compiled.length, note: "executed in the sandbox" },
    { label: "passed", n: passed.length, note: "the suite went green" },
    { label: "mutation-cleared", n: cleared.length, note: "killed enough mutants to assert something" },
    { label: "proposed", n: proposed.length, note: "reached a pull request" },
  ];
  const widest = Math.max(1, ...stages.map((s) => s.n));

  const firstAttempts = real.filter((a) => a.attempt === 1);
  const firstPassed = firstAttempts.filter((a) => a.outcome === "passed").length;
  const firstRate = firstAttempts.length ? Math.round((firstPassed / firstAttempts.length) * 100) : null;
  const meanMutation = mutations.length
    ? Math.round((mutations.reduce((s, m) => s + (m.score ?? 0), 0) / mutations.length) * 10) / 10
    : null;

  const models = new Set(real.map((a) => a.usage.model).filter(Boolean));

  return (
    <>
      <Bar crumb="evidence" title="Test funnel" meta={`${started.length} targets`} />

      <div className="page">
        <p className="lede">
          A generated test that has not been executed is a guess. Nothing reaches a pull request
          without running in the sandbox and clearing the mutation threshold — and{" "}
          <b>every attempt is recorded, including the failures</b>, because a pass rate without its
          denominator means nothing.
        </p>

        <div className="stats">
          <Stat
            k="first-attempt pass"
            v={firstRate === null ? "—" : `${firstRate}%`}
            note={`${firstPassed}/${firstAttempts.length} generations`}
          />
          <Stat
            k="mean mutation"
            v={meanMutation === null ? "—" : `${meanMutation}%`}
            note="threshold 40%"
            tone={meanMutation !== null && meanMutation >= 40 ? "good" : meanMutation === null ? undefined : "bad"}
          />
          <Stat k="reached a PR" v={proposed.length} tone={proposed.length > 0 ? "good" : undefined} />
          {outages.length > 0 ? (
            <Stat k="api outages" v={outages.length} note="excluded from the funnel" tone="attn" />
          ) : null}
        </div>

        <Panel
          title="Funnel"
          aside={models.size > 1 ? `${models.size} models — see attempts` : [...models][0] ?? ""}
        >
          <div className="pad funnel">
            {stages.map((stage, i) => {
              const prev = i === 0 ? null : stages[i - 1]!.n;
              // Drop-off is the point of a funnel; bars alone are just counts.
              const lost = prev !== null && prev > 0 ? prev - stage.n : 0;
              return (
                <div className="fstage" key={stage.label}>
                  <span className="label" title={stage.note}>
                    {stage.label}
                  </span>
                  <span className="track">
                    <span style={{ width: `${(stage.n / widest) * 100}%` }} />
                  </span>
                  <span className="n">{stage.n}</span>
                  <span className={`drop${lost > 0 ? " loss" : ""}`}>
                    {i === 0 ? "" : lost > 0 ? `−${lost}` : "—"}
                  </span>
                </div>
              );
            })}
          </div>
        </Panel>

        {outages.length > 0 ? (
          <Panel title="Excluded — model API unavailable" aside={`${outages.length}`}>
            <table>
              <thead>
                <tr>
                  <th>target</th>
                  <th>reason</th>
                  <th className="num">when</th>
                </tr>
              </thead>
              <tbody>
                {outages.map((o) => (
                  <tr key={o.id}>
                    <td className="mono">{o.target}</td>
                    <td className="note">{o.failureSummary?.slice(0, 110) ?? "unknown"}</td>
                    <td className="num">
                      <RelTime iso={o.ts} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        ) : null}

        <div className="split">
          <Panel title="Attempts" aside={`${real.length}`} scroll>
            {real.length === 0 ? (
              <Empty>
                No attempts recorded. Run <code>pnpm testgen</code>.
              </Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>target</th>
                    <th className="num">#</th>
                    <th>outcome</th>
                    <th>model</th>
                    <th className="num">tok</th>
                    <th className="num">ms</th>
                  </tr>
                </thead>
                <tbody>
                  {real.map((a) => (
                    <tr key={a.id}>
                      <td className="mono">{a.target}</td>
                      <td className="num">{a.attempt}</td>
                      <td>
                        <Tag tone={a.outcome === "passed" ? "ok" : "bad"} solid>
                          {a.outcome}
                        </Tag>
                      </td>
                      <td className="mono" style={{ color: "var(--dim)" }}>
                        {a.usage.model ?? "—"}
                      </td>
                      <td className="num">{compact(a.usage.totalTokens)}</td>
                      <td className="num">{a.durationMs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel title="Mutation scores" aside={`threshold 40%`} scroll>
            {mutations.length === 0 ? (
              <Empty>No mutation runs yet.</Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>target</th>
                    <th className="num">score</th>
                    <th className="num">killed</th>
                    <th className="num">survived</th>
                    <th>verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {mutations.map((m) => (
                    <tr key={m.id}>
                      <td className="mono">{m.target}</td>
                      <td className="num">{m.score ?? "—"}%</td>
                      <td className="num">{m.killed}</td>
                      <td className="num">{m.survived}</td>
                      <td>
                        <Tag tone={m.cleared ? "ok" : "bad"} solid>
                          {m.cleared ? "cleared" : "below"}
                        </Tag>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
