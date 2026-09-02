import type { ReactNode } from "react";

/** The one line that says where you are and how fresh this is. */
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
      <span className="crumb">{crumb} /</span>
      <h1>{title}</h1>
      <span className="spacer" />
      {meta ? <span className="meta">{meta}</span> : null}
    </div>
  );
}
