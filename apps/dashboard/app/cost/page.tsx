import Bar from "../bar";
import { loadSummary, pick } from "@/lib/queries";
import { compact, Empty, Panel, Stat, Tag } from "../ui";

export const dynamic = "force-dynamic";

export default async function Page() {
  const { tokens, latest } = await loadSummary(500);

  const withUsage = [...pick(latest, "review.completed"), ...pick(latest, "testgen.attempt")];
  const thought = withUsage.reduce((s, e) => s + e.usage.thoughtTokens, 0);
  const prompt = withUsage.reduce((s, e) => s + e.usage.promptTokens, 0);
  const measured = withUsage.reduce((s, e) => s + e.usage.totalTokens, 0);
  const thoughtShare = measured ? Math.round((thought / measured) * 100) : 0;

  const total = tokens.reduce((s, t) => s + t.tokens, 0);
  const calls = tokens.reduce((s, t) => s + t.calls, 0);
  const widest = Math.max(1, ...tokens.map((t) => t.tokens));

  /**
   * Spend split by the model that actually served each call.
   *
   * Automatic fallback means one run can be served by a different model than
   * the one requested, so a single blended total hides both the cost and the
   * fact that quality varied between rows.
   */
  const byModel = new Map<string, { tokens: number; calls: number }>();
  for (const e of withUsage) {
    const key = e.usage.model ?? "unrecorded";
    const entry = byModel.get(key) ?? { tokens: 0, calls: 0 };
    entry.tokens += e.usage.totalTokens;
    entry.calls += 1;
    byModel.set(key, entry);
  }
  const modelWidest = Math.max(1, ...[...byModel.values()].map((v) => v.tokens));

  return (
    <>
      <Bar crumb="evidence" title="Spend" meta={`${calls} model calls`} />

      <div className="page">
        <p className="lede">
          Cumulative usage per subsystem and per serving model.{" "}
          <b>Thinking tokens are counted explicitly</b> because they are billed and never appear in
          the output — a cost figure that omits them is wrong by a large multiple.
        </p>

        <div className="stats">
          <Stat k="total tokens" v={compact(total)} note={`${calls} calls`} />
          <Stat k="prompt" v={compact(prompt)} />
          <Stat
            k="thinking"
            v={compact(thought)}
            note={`${thoughtShare}% of measured spend`}
            tone={thoughtShare > 40 ? "attn" : undefined}
          />
          <Stat k="models used" v={byModel.size} note="after fallback" />
        </div>

        <div className="split">
          <Panel title="By subsystem">
            {tokens.length === 0 ? (
              <Empty>No model calls recorded yet.</Empty>
            ) : (
              <div className="pad rows">
                {tokens.map((t) => (
                  <div className="row2" key={t.subsystem}>
                    <span className="label">{t.subsystem}</span>
                    <span className="track">
                      <span style={{ width: `${(t.tokens / widest) * 100}%` }} />
                    </span>
                    <span className="val">
                      {compact(t.tokens)} · {t.calls}c
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="By serving model" aside="fallback-aware">
            {byModel.size === 0 ? (
              <Empty>No usage recorded against a model yet.</Empty>
            ) : (
              <div className="pad rows">
                {[...byModel.entries()]
                  .sort((a, b) => b[1].tokens - a[1].tokens)
                  .map(([model, v]) => (
                    <div className="row2" key={model}>
                      <span className="label" title={model}>
                        {model === "unrecorded" ? (
                          <Tag tone="warn">unrecorded</Tag>
                        ) : (
                          model.replace("gemini-", "")
                        )}
                      </span>
                      <span className="track">
                        <span style={{ width: `${(v.tokens / modelWidest) * 100}%` }} />
                      </span>
                      <span className="val">
                        {compact(v.tokens)} · {v.calls}c
                      </span>
                    </div>
                  ))}
              </div>
            )}
          </Panel>
        </div>

        {byModel.has("unrecorded") ? (
          <p className="lede footnote">
            Calls marked <b>unrecorded</b> predate model attribution. Their tokens are counted, but
            they cannot be attributed to a model, so per-model rates should be read as a lower bound.
          </p>
        ) : null}
      </div>
    </>
  );
}
