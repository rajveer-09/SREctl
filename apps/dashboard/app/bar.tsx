import type { ReactNode } from "react";
import Live from "./live";

/**
 * The one line that says where you are and how fresh this is.
 *
 * The title is the largest thing on the page. It used to be set at the body
 * size, which left every view opening with five near-identical rows of small
 * text and no obvious entry point for the eye.
 */
export default function Bar({
  crumb,
  title,
  meta,
}: {
  crumb: string;
  title: string;
  meta?: ReactNode;
}) {
  return (
    <div className="bar">
      <div className="head">
        <span className="crumb">{crumb}</span>
        <h1>{title}</h1>
      </div>
      <span className="spacer" />
      {meta ? <span className="meta">{meta}</span> : null}
      <Live />
    </div>
  );
}
