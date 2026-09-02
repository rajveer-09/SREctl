import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * A job is the normalized, trusted-shape summary of an untrusted webhook
 * payload. `raw` is carried along deliberately and is never treated as
 * instruction — Phase 1 wraps it before it reaches a model.
 */
export const JobSchema = z.object({
  id: z.string(), // the GitHub delivery ID — makes enqueue idempotent
  kind: z.enum(["review_pr", "index_push"]),
  repo: z.string(),
  prNumber: z.number().int().optional(),
  headSha: z.string().optional(),
  receivedAt: z.string(),
  raw: z.unknown(),
});

export type Job = z.infer<typeof JobSchema>;

export interface Queue {
  enqueue(job: Job): Promise<void>;
  /** Removes and returns every pending job. Phase 6 swaps this for Pub/Sub. */
  drain(): Promise<Job[]>;
  size(): Promise<number>;
}

export class FileQueue implements Queue {
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, "queue.jsonl");
  }

  async enqueue(job: Job): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(job) + "\n", "utf8");
  }

  private async readAll(): Promise<Job[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: Job[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const parsed = JobSchema.safeParse(JSON.parse(line));
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }

  async drain(): Promise<Job[]> {
    const jobs = await this.readAll();
    if (jobs.length > 0) await writeFile(this.path, "", "utf8");
    return jobs;
  }

  async size(): Promise<number> {
    return (await this.readAll()).length;
  }
}

export class MemoryQueue implements Queue {
  private jobs: Job[] = [];
  async enqueue(job: Job): Promise<void> {
    this.jobs.push(job);
  }
  async drain(): Promise<Job[]> {
    const out = this.jobs;
    this.jobs = [];
    return out;
  }
  async size(): Promise<number> {
    return this.jobs.length;
  }
}
