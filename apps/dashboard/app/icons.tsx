/**
 * Inline 16px stroke icons.
 *
 * Drawn rather than imported: an icon package is 40kB to render six glyphs,
 * and emoji in an operator console reads as a toy. Each shape says something
 * about the view it labels rather than being decorative.
 */

const base = {
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** A signal trace: the live event stream. */
export const IconActivity = () => (
  <svg {...base} aria-hidden="true">
    <path d="M1 8h3l2-5 3.5 10L12 8h3" />
  </svg>
);

/** Nodes converging: files pulled in from different tiers. */
export const IconRetrieval = () => (
  <svg {...base} aria-hidden="true">
    <circle cx="3" cy="3.5" r="1.6" />
    <circle cx="3" cy="12.5" r="1.6" />
    <circle cx="13" cy="8" r="1.6" />
    <path d="M4.5 4.4 11.5 7.3M4.5 11.6 11.5 8.7" />
  </svg>
);

/** A narrowing stack: the test funnel. */
export const IconFunnel = () => (
  <svg {...base} aria-hidden="true">
    <path d="M1.5 2.5h13L9.5 8v5.5l-3 1.5V8z" />
  </svg>
);

/** Pods on a node: cluster state. */
export const IconCluster = () => (
  <svg {...base} aria-hidden="true">
    <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.2" />
    <rect x="9" y="1.5" width="5.5" height="5.5" rx="1.2" />
    <rect x="1.5" y="9" width="5.5" height="5.5" rx="1.2" />
    <rect x="9" y="9" width="5.5" height="5.5" rx="1.2" />
  </svg>
);

/** A meter: cumulative spend. */
export const IconCost = () => (
  <svg {...base} aria-hidden="true">
    <path d="M2 13a6 6 0 1 1 12 0" />
    <path d="M8 13 11 7" />
  </svg>
);

/** The product mark: a bracketed cursor. Terminal-adjacent, not a terminal. */
export const IconMark = () => (
  <svg viewBox="0 0 18 18" fill="none" aria-hidden="true" className="glyph">
    <path
      d="M5.4 2.5 2.5 5.4v7.2l2.9 2.9M12.6 2.5l2.9 2.9v7.2l-2.9 2.9"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <rect x="7.6" y="7.6" width="2.8" height="2.8" rx="0.6" fill="currentColor" />
  </svg>
);
