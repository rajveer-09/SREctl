import { randomBytes } from "node:crypto";

/**
 * The trust boundary.
 *
 * The agent reads PR titles, descriptions, diffs and comments, and then acts
 * with a GitHub token. All of that text is attacker-controllable, so it is
 * data the agent reads, never instructions it follows.
 *
 * Three mechanisms, in decreasing order of how much they can be relied on:
 *
 *   1. Capability limits (the path allowlist, the fine-grained PAT scope).
 *      Enforced in code. These are the actual defence.
 *   2. Delimiter integrity: content cannot close its own block and start
 *      speaking as the system. Mechanical, and it holds.
 *   3. Instruction-pattern neutralization and prompt framing. These raise the
 *      cost of an attack. They do not make one impossible, and nothing here
 *      should be described as though they did.
 */

export type UntrustedKind = "pr-title" | "pr-body" | "pr-comment" | "diff" | "file";

export interface InjectionFinding {
  pattern: string;
  match: string;
  action: "neutralized" | "flagged";
}

export interface WrappedContent {
  text: string;
  findings: InjectionFinding[];
}

/**
 * Instruction-shaped patterns. Deliberately narrow: matching loosely on words
 * like "system" would mangle ordinary code and review prose, and a wrapper
 * that corrupts real content is a wrapper someone eventually switches off.
 */
const INSTRUCTION_PATTERNS: Array<{ name: string; source: string; flags: string }> = [
  {
    name: "ignore-previous",
    source: String.raw`\b(ignore|disregard|forget)\s+(all\s+|any\s+)?(previous|prior|earlier|above|preceding)\s+(instructions?|prompts?|rules?|context)\b`,
    flags: "gi",
  },
  {
    name: "new-instructions",
    source: String.raw`\bnew\s+(system\s+)?(instructions?|rules?|directives?)\s*:`,
    flags: "gi",
  },
  { name: "role-reassignment", source: String.raw`\byou\s+are\s+now\s+(a|an|the)\b`, flags: "gi" },
  {
    name: "override-rules",
    source: String.raw`\boverride\s+(your|the|all)\s+(instructions?|rules?|guidelines?|restrictions?|constraints?)\b`,
    flags: "gi",
  },
  {
    name: "reveal-prompt",
    source: String.raw`\b(reveal|print|show|output|repeat)\s+(your|the)\s+(system\s+)?(prompt|instructions?)\b`,
    flags: "gi",
  },
  { name: "chat-role-tag", source: String.raw`<\/?\s*(system|assistant|user)\s*>`, flags: "gi" },
  { name: "role-prefix", source: String.raw`^\s*(system|assistant)\s*:\s*`, flags: "gim" },
  {
    name: "secrecy",
    source: String.raw`\bdo\s+not\s+(tell|inform|mention|report|disclose)\s+(the\s+)?(user|human|reviewer|anyone)\b`,
    flags: "gi",
  },
  {
    // The noun is usually an identifier, not a bare word: real attempts say
    // GITHUB_TOKEN or process.env.API_KEY. `\btoken\b` never matches inside
    // GITHUB_TOKEN, because underscore is a word character and there is no
    // boundary before TOKEN. Allow an identifier prefix, and a short window
    // between the verb and its object.
    name: "exfiltrate",
    source: String.raw`\b(send|post|upload|leak|exfiltrate|transmit)\b[^\n]{0,60}?\b\w*(token|secret|credential|api[_ -]?key|password)\b`,
    flags: "gi",
  },
];

const TAG = "untrusted-data";

/**
 * Prevents delimiter injection two ways.
 *
 * A fixed delimiter can be guessed and closed by the content itself, letting
 * attacker text escape its block and continue as though it were the system
 * prompt. So each block carries a random nonce the content cannot know, AND
 * any literal occurrence of the tag name in the body is escaped. Either alone
 * would be weaker than both together.
 */
function escapeDelimiters(content: string): string {
  return content.split(TAG).join("untrusted&#45;data");
}

/** Reports instruction-shaped spans without modifying the content. */
export function scan(content: string): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  for (const { name, source, flags } of INSTRUCTION_PATTERNS) {
    for (const m of content.matchAll(new RegExp(source, flags))) {
      findings.push({ pattern: name, match: m[0].slice(0, 120), action: "flagged" });
    }
  }
  return findings;
}

/**
 * Wraps untrusted content in a nonce-delimited, labelled block.
 *
 * `prose` (titles, descriptions, comments) has instruction-shaped spans
 * replaced, because that text carries no engineering value a replacement
 * would destroy.
 *
 * `code` (diffs, file bodies) is never rewritten. Silently editing the code
 * under review would produce a review of something the author did not write.
 * Findings are reported instead, and it is the capability limits, not the
 * text, that stop an action.
 */
export function wrapUntrusted(opts: {
  kind: UntrustedKind;
  content: string;
  label?: string;
}): WrappedContent {
  const isProse =
    opts.kind === "pr-title" || opts.kind === "pr-body" || opts.kind === "pr-comment";

  let body = escapeDelimiters(opts.content);
  const findings: InjectionFinding[] = [];

  for (const { name, source, flags } of INSTRUCTION_PATTERNS) {
    for (const m of body.matchAll(new RegExp(source, flags))) {
      findings.push({
        pattern: name,
        match: m[0].slice(0, 120),
        action: isProse ? "neutralized" : "flagged",
      });
    }
    if (isProse) {
      body = body.replace(new RegExp(source, flags), "[removed: instruction-shaped text]");
    }
  }

  const nonce = randomBytes(8).toString("hex");
  const label = opts.label ? ` label="${opts.label.replace(/"/g, "'")}"` : "";
  const open = "<" + TAG + ":" + nonce + ' kind="' + opts.kind + '"' + label + ">";
  const close = "</" + TAG + ":" + nonce + ">";

  return { text: open + "\n" + body + "\n" + close, findings };
}

export function summarizeFindings(findings: InjectionFinding[]): string {
  if (findings.length === 0) return "none";
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.pattern, (counts.get(f.pattern) ?? 0) + 1);
  return [...counts.entries()].map(([p, n]) => `${p} x${n}`).join(", ");
}
