import { getStore } from "./store";
import type { SrectlEvent } from "@srectl/core";

export interface Summary {
  totals: Array<{ type: string; count: number }>;
  tokens: Array<{ subsystem: string; tokens: number; calls: number }>;
  latest: SrectlEvent[];
}

export async function loadSummary(limit = 200): Promise<Summary> {
  const store = getStore();
  const [totals, tokens, latest] = await Promise.all([
    store.countsByType(),
    store.tokensBySubsystem(),
    store.latest(limit),
  ]);
  return { totals, tokens, latest: latest.map((r) => r.event) };
}

export function pick<T extends SrectlEvent["type"]>(
  events: SrectlEvent[],
  type: T,
): Extract<SrectlEvent, { type: T }>[] {
  return events.filter((e): e is Extract<SrectlEvent, { type: T }> => e.type === type);
}
