"use client";

import { useEffect, useState } from "react";

export type SrectlEvent = { id: string; ts: string; type: string; correlationId: string } & Record<
  string,
  unknown
>;

/**
 * One EventSource shared by the whole page.
 *
 * Every component that wants live data subscribing separately would open a
 * connection each, and each connection costs a server-side polling loop
 * against Postgres. A module-level singleton keeps it at one per tab.
 *
 * The browser handles reconnection itself and replays Last-Event-ID, so the
 * server resumes from the exact sequence this tab last saw.
 */
type Listener = (events: SrectlEvent[], status: Status) => void;
type Status = "connecting" | "open" | "error";

let source: EventSource | null = null;
let buffer: SrectlEvent[] = [];
let status: Status = "connecting";
const listeners = new Set<Listener>();

const MAX_BUFFERED = 500;

function notify() {
  for (const listener of listeners) listener(buffer, status);
}

function ensureConnected() {
  if (source || typeof window === "undefined") return;

  source = new EventSource("/api/stream");
  source.onopen = () => {
    status = "open";
    notify();
  };
  source.onerror = () => {
    status = "error";
    notify();
  };
  source.addEventListener("srectl", (e) => {
    try {
      const event = JSON.parse((e as MessageEvent).data) as SrectlEvent;
      // Newest first, bounded: an agent left running overnight must not grow
      // the tab's memory without limit.
      buffer = [event, ...buffer].slice(0, MAX_BUFFERED);
      status = "open";
      notify();
    } catch {
      /* malformed frame: skip rather than break the stream */
    }
  });
}

export function useStream(): { events: SrectlEvent[]; status: Status; count: number } {
  const [snapshot, setSnapshot] = useState<{ events: SrectlEvent[]; status: Status }>({
    events: buffer,
    status,
  });

  useEffect(() => {
    ensureConnected();
    const listener: Listener = (events, s) => setSnapshot({ events: [...events], status: s });
    listeners.add(listener);
    listener(buffer, status);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return { events: snapshot.events, status: snapshot.status, count: snapshot.events.length };
}
