import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * Spawns an external tool, portably and without a shell.
 *
 * Three Windows problems, each of which reports itself as something else:
 *
 * 1. Several SDKs ship no .exe. `gcloud` is `gcloud.cmd` and `gcloud.ps1`, so
 *    Node's spawn with shell:false fails `spawn gcloud ENOENT` even though
 *    `where.exe gcloud` finds it and PATH is correct.
 *
 * 2. The obvious fix, shell:true, hands an unescaped command line to cmd.exe.
 *    Node 24 warns about this (DEP0190) because arguments are concatenated
 *    rather than escaped - anything derived from input becomes an injection.
 *
 * 3. Routing a .cmd through `cmd /d /s /c` has a quoting rule that only bites
 *    when a path contains a space: /s strips the FIRST and LAST quote of
 *    everything after /c. A quoted path is therefore unquoted and splits, which
 *    surfaced here as
 *      'C:\Users\rajve\AppData\Local\Google\Cloud' is not recognized
 *    for a path containing "Cloud SDK".
 *
 * So the command line is built here, wrapped in an extra pair of quotes (the
 * pair cmd consumes), and passed verbatim so Node does not re-quote it.
 */
export function spawnTool(
  command: string,
  args: string[],
  opts: { cwd?: string; quiet?: boolean } = {},
): Promise<void> {
  const plan = resolveCommand(command, args);

  return new Promise((resolve, reject) => {
    const child = spawn(plan.file, plan.args, {
      shell: false,
      stdio: opts.quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
      ...(plan.verbatim ? { windowsVerbatimArguments: true } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });

    let captured = "";
    child.stdout?.on("data", (c) => (captured += c.toString()));
    child.stderr?.on("data", (c) => (captured += c.toString()));

    child.on("error", (err) =>
      reject(new Error(`could not start "${command}": ${(err as Error).message}`)),
    );
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(`${command} exited ${code}${captured ? `\n${captured.slice(-1500)}` : ""}`),
          ),
    );
  });
}

interface LaunchPlan {
  file: string;
  args: string[];
  /** True when we built the command line ourselves and Node must not re-quote. */
  verbatim: boolean;
}

function resolveCommand(command: string, args: string[]): LaunchPlan {
  if (process.platform !== "win32") return { file: command, args, verbatim: false };

  const found = isAbsolute(command) ? command : searchPath(command);
  if (!found) return { file: command, args, verbatim: false }; // let spawn report it

  if (/\.(cmd|bat)$/i.test(found)) {
    const line = [found, ...args].map(quoteArg).join(" ");
    return {
      file: process.env["ComSpec"] ?? "cmd.exe",
      args: ["/d", "/s", "/c", `"${line}"`],
      verbatim: true,
    };
  }

  // A real executable: no shell, no cmd quoting rules, Node handles the rest.
  return { file: found, args, verbatim: false };
}

/** Quotes only what needs it: quoting a flag like --a=b breaks cmd parsing. */
function quoteArg(arg: string): string {
  if (arg.length > 0 && !/[\s"^&|<>()]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function searchPath(command: string): string | null {
  const dirs = (process.env["PATH"] ?? "").split(delimiter).filter(Boolean);
  // .exe first: it spawns directly and skips the cmd.exe hop entirely.
  const extensions = [".exe", ".cmd", ".bat", ""];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = join(dir, command + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
