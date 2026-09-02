import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * GitHub retries deliveries. A duplicate review is worse than a slow one, so
 * every delivery ID is recorded before any work is scheduled.
 */
export interface Dedupe {
  /** Records the id and returns true if it had already been seen. */
  seen(id: string): Promise<boolean>;
}

const MAX_IDS = 10_000;

export class FileDedupe implements Dedupe {
  private readonly path: string;
  private loading: Promise<Set<string>> | undefined;

  constructor(dataDir: string) {
    this.path = join(dataDir, "deliveries.txt");
  }

  /**
   * Caches the in-flight promise, not the resolved Set. A burst of concurrent
   * deliveries against a cold instance would otherwise each start its own read
   * and build its own Set, and every one but the last would be discarded —
   * silently losing the IDs recorded in them.
   */
  private load(): Promise<Set<string>> {
    this.loading ??= this.readIds();
    return this.loading;
  }

  private async readIds(): Promise<Set<string>> {
    let lines: string[] = [];
    try {
      lines = (await readFile(this.path, "utf8")).split("\n").filter((l) => l.trim());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    // Keep the file bounded: an ingest service that runs for months should not
    // grow an unbounded dedupe log.
    if (lines.length > MAX_IDS) {
      lines = lines.slice(-MAX_IDS);
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.path, lines.join("\n") + "\n", "utf8");
    }

    return new Set(lines);
  }

  async seen(id: string): Promise<boolean> {
    const ids = await this.load();
    if (ids.has(id)) return true;
    ids.add(id);
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, id + "\n", "utf8");
    return false;
  }
}

export class MemoryDedupe implements Dedupe {
  private readonly ids = new Set<string>();
  async seen(id: string): Promise<boolean> {
    if (this.ids.has(id)) return true;
    this.ids.add(id);
    return false;
  }
}
