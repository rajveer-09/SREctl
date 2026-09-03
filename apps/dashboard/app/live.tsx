"use client";

import { useStream } from "./use-stream";

/**
 * Connection state in the page header.
 *
 * The rail already carries this, but the rail is the one thing a reader stops
 * looking at after the first page. On a live console the question "is this
 * still updating, or am I looking at a frozen page?" has to be answerable from
 * wherever the eye already is, which is the header.
 *
 * Its own client component so the header itself can stay a server component
 * and keep rendering on the server with the page's data.
 */
export default function Live() {
  const { status } = useStream();

  const tone = status === "open" ? "on" : status === "error" ? "err" : "";
  const label = status === "open" ? "live" : status === "error" ? "reconnecting" : "connecting";

  return (
    <span className={`live ${tone}`.trim()} title={`Event stream: ${status}`}>
      <span className={`beacon ${tone}`.trim()} />
      {label}
    </span>
  );
}
