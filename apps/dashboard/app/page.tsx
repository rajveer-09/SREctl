import Bar from "./bar";
import Feed from "./feed";
import { loadSummary, pick } from "@/lib/queries";
import { compact, Panel, Stat } from "./ui";

export const dynamic = "force-dynamic";

export default async function Page() {
  const { totals, latest, tokens } = await loadSummary(250);

  const count = (type: string) => totals.find((t) => t.type === type)?.count ?? 0;
  const total = totals.reduce((s, t) => s + t.count, 0);
  const totalTokens = tokens.reduce((s, t) => s + t.tokens, 0);

  const incidents = pick(latest, "incident.opened");
  const triaged = pick(latest, "incident.triaged");
  const byRule = triaged.filter((t) => t.source === "rule").length;
  const rejected = count("webhook.rejected");

  // Ingest latency is the only claim with a hard external deadline attached
  // (GitHub gives ~10s), so it belongs on the front page rather than buried.
  const handled = pick(latest, "webhook.received").map((e) => e.handlingMs);
  const slowest = handled.length ? Math.max(...handled) : null;

  return (
    <>
      <Bar
        crumb="observe"
        title="Activity"
        meta={`${total} events · ${tokens.reduce((s, t) => s + t.calls, 0)} model calls`}
      />

      <div className="page">
        <p className="lede">
          Every action the agents took, streamed over SSE as it happened. Nothing here is polled and
          nothing is seeded — these are the events the pipelines emitted while running.
        </p>

        <div className="stats">
          <Stat k="deliveries" v={count("webhook.received")} note={`${count("webhook.duplicate")} deduplicated`} />
          <Stat
            k="ingest p-max"
            v={slowest === null ? "—" : `${slowest.toFixed(1)}ms`}
            note="GitHub allows ~10s"
            tone={slowest !== null && slowest > 1000 ? "attn" : "good"}
          />
          <Stat k="reviews" v={count("review.completed")} note={`${count("retrieval.completed")} retrievals`} />
          <Stat
            k="incidents"
            v={incidents.length}
            note={`${byRule} answered by rules`}
            tone={incidents.length > 0 ? "attn" : undefined}
          />
          <Stat k="tokens" v={compact(totalTokens)} note="across all subsystems" />
          {rejected > 0 ? <Stat k="rejected" v={rejected} note="failed HMAC or malformed" tone="bad" /> : null}
        </div>

        <Panel title="Event stream" aside="newest first" scroll>
          <Feed initial={latest} />
        </Panel>
      </div>
    </>
  );
}
