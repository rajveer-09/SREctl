import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SrectlEventSchema, type SrectlEvent } from "./events.js";

export interface EventStore {
  append(event: SrectlEvent): Promise<void>;
  read(): Promise<SrectlEvent[]>;
}

/**
 * JSONL on disk. Phase 5 replaces this with PgEventStore behind the same
 * interface; nothing that appends events needs to change.
 */
export class FileEventStore implements EventStore {
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, "events.jsonl");
  }

  async append(event: SrectlEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(event) + "\n", "utf8");
  }

  async read(): Promise<SrectlEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const out: SrectlEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const parsed = SrectlEventSchema.safeParse(JSON.parse(line));
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }
}

/** In-memory store for tests. */
export class MemoryEventStore implements EventStore {
  readonly events: SrectlEvent[] = [];
  async append(event: SrectlEvent): Promise<void> {
    this.events.push(event);
  }
  async read(): Promise<SrectlEvent[]> {
    return [...this.events];
  }
}
