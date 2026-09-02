import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import { CHAOS_CASES, CHAOS_NS } from "../eval/chaos/cases.js";

const action = process.argv[2] ?? "up";
const kc = new KubeConfig();
kc.loadFromDefault();
const core = kc.makeApiClient(CoreV1Api);

if (action === "down") {
  await core.deleteNamespace({ name: CHAOS_NS }).catch(() => undefined);
  console.log(`deleted namespace ${CHAOS_NS}`);
  process.exit(0);
}

/**
 * Namespace deletion is asynchronous. A create issued while the previous one
 * is still Terminating fails with 409, so `chaos:down && chaos:up` races
 * itself unless we wait the old one out.
 */
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    await core.createNamespace({
      body: { metadata: { name: CHAOS_NS, labels: { "srectl/chaos": "true" } } },
    });
    break;
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code !== 409) throw e;

    const existing = await core.readNamespace({ name: CHAOS_NS }).catch(() => null);
    if (existing?.status?.phase !== "Terminating") break; // already exists and usable
    if (attempt === 0) console.log("waiting for the previous namespace to finish terminating...");
    await new Promise((r) => setTimeout(r, 1000));
  }
}

let created = 0;
for (const testCase of CHAOS_CASES) {
  await core
    .createNamespacedPod({ namespace: CHAOS_NS, body: testCase.pod })
    .then(() => (created += 1))
    .catch((e) => {
      if ((e as { code?: number }).code !== 409) throw e;
    });
}

console.log(`seeded ${created} broken pods in ${CHAOS_NS} (${CHAOS_CASES.length} cases total)`);
console.table(
  CHAOS_CASES.map((c) => ({ name: c.name, class: c.faultClass, expects: c.expectedSignal })),
);
