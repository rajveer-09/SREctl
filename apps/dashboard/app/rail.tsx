"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  IconActivity,
  IconCluster,
  IconCost,
  IconFunnel,
  IconMark,
  IconRetrieval,
} from "./icons";
import { useStream } from "./use-stream";

const SECTIONS = [
  {
    group: "observe",
    links: [
      { href: "/", label: "Activity", Icon: IconActivity },
      { href: "/cluster", label: "Cluster", Icon: IconCluster },
    ],
  },
  {
    group: "evidence",
    links: [
      { href: "/reviews", label: "Retrieval", Icon: IconRetrieval },
      { href: "/tests", label: "Test funnel", Icon: IconFunnel },
      { href: "/cost", label: "Spend", Icon: IconCost },
    ],
  },
] as const;

export default function Rail() {
  const path = usePathname();
  const { status, count } = useStream();

  return (
    <aside className="rail">
      <div className="mark">
        <IconMark />
        <b>SREctl</b>
        <i>console</i>
      </div>

      {SECTIONS.map((section) => (
        <div key={section.group}>
          <div className="group">{section.group}</div>
          <nav>
            {section.links.map(({ href, label, Icon }) => (
              <Link key={href} href={href} aria-current={path === href ? "page" : undefined}>
                <Icon />
                {label}
              </Link>
            ))}
          </nav>
        </div>
      ))}

      <div className="foot">
        <span className="status">
          <span className={`beacon ${status === "open" ? "on" : status === "error" ? "err" : ""}`} />
          {status === "open" ? "streaming" : status === "error" ? "reconnecting" : "connecting"}
        </span>
        <span>{count} live event{count === 1 ? "" : "s"}</span>
      </div>
    </aside>
  );
}
