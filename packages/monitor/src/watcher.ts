import { CoreV1Api, KubeConfig, Watch, type V1Pod } from "@kubernetes/client-node";
import type { Logger } from "@srectl/core";

export type PodEventType = "ADDED" | "MODIFIED" | "DELETED";

export interface PodObservation {
  type: PodEventType;
  pod: V1Pod;
  at: string;
}

export interface WatcherOptions {
  namespaces: string[];
  onPod: (observation: PodObservation) => void | Promise<void>;
  logger?: Logger;
}

/**
 * Watches Pods across namespaces and reacts to state transitions.
 *
 * The client library and the Watch API, not polling and diffing `kubectl`
 * output. Polling shows you a state; a watch shows you the change, which is
 * what "detection latency" is actually measuring.
 *
 * Two things every naive watch gets wrong:
 *
 *   1. `410 Gone`. The API server only retains a bounded window of history.
 *      A watch resumed from a resourceVersion older than that window is
 *      rejected, and the correct response is to RELIST and start again - not
 *      to retry the same version, and not to die. This is the failure that
 *      shows up about an hour in, long after the code looks finished.
 *   2. Watches end normally. A connection that closes without error is not a
 *      failure, it is the expected lifecycle, and it must be restarted.
 */
export class PodWatcher {
  private readonly watch: Watch;
  private readonly core: CoreV1Api;
  private readonly abort = new AbortController();
  private running = false;
  private restarts = 0;
  private relists = 0;

  constructor(private readonly opts: WatcherOptions) {
    const kc = new KubeConfig();
    kc.loadFromDefault();
    this.watch = new Watch(kc);
    this.core = kc.makeApiClient(CoreV1Api);
  }

  get stats(): { restarts: number; relists: number } {
    return { restarts: this.restarts, relists: this.relists };
  }

  async start(): Promise<void> {
    this.running = true;
    await Promise.all(this.opts.namespaces.map((ns) => this.watchNamespace(ns)));
  }

  stop(): void {
    this.running = false;
    this.abort.abort();
  }

  private async watchNamespace(namespace: string): Promise<void> {
    while (this.running) {
      let resourceVersion: string | undefined;

      try {
        // Relist first: the initial state is not a stream of events, and a
        // pod already broken before we started would otherwise be invisible
        // until it next changed.
        const list = await this.core.listNamespacedPod({ namespace });
        resourceVersion = list.metadata?.resourceVersion;
        this.relists += 1;

        for (const pod of list.items) {
          await this.opts.onPod({ type: "ADDED", pod, at: new Date().toISOString() });
        }

        await this.streamFrom(namespace, resourceVersion);
      } catch (err) {
        if (!this.running) return;

        if (isGone(err)) {
          // Expected, not exceptional: our resourceVersion aged out of the
          // server's history window. Loop round and relist.
          this.opts.logger?.debug("watch expired, relisting", { namespace });
          continue;
        }

        this.restarts += 1;
        this.opts.logger?.warn("watch error, restarting", {
          namespace,
          error: (err as Error).message,
        });
        await sleep(Math.min(1000 * this.restarts, 10_000));
      }
    }
  }

  private streamFrom(namespace: string, resourceVersion: string | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      this.watch
        .watch(
          `/api/v1/namespaces/${namespace}/pods`,
          { resourceVersion, allowWatchBookmarks: true },
          (type, obj: V1Pod) => {
            void this.opts.onPod({
              type: type as PodEventType,
              pod: obj,
              at: new Date().toISOString(),
            });
          },
          // A watch closing with no error is normal. Resolve so the outer loop
          // relists and reconnects rather than treating it as a crash.
          (err) => (err ? reject(err) : resolve()),
        )
        .then((req) => {
          this.abort.signal.addEventListener("abort", () => req.abort(), { once: true });
        })
        .catch(reject);
    });
  }
}

/** The API server rejects a resourceVersion that has aged out with 410. */
export function isGone(err: unknown): boolean {
  const e = err as { statusCode?: number; code?: number; message?: string };
  return e?.statusCode === 410 || e?.code === 410 || /too old resource version/i.test(e?.message ?? "");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
