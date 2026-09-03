import { mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";

/**
 * Bundles the deployable apps into single files.
 *
 * Node's --experimental-strip-types is not an option here: it only handles
 * ERASABLE syntax, and this codebase uses constructor parameter properties
 * (`constructor(private readonly pool: pg.Pool)`) throughout. Those are not
 * erasable, so a strip-types image fails at startup rather than at build time -
 * the worst place to find out.
 *
 * Workspace code is bundled; node_modules stays external and is installed in
 * the image. The Google Cloud clients and `pg` carry native and dynamically
 * required pieces that a bundler mangles, and the image is not meaningfully
 * smaller for the risk.
 */

const APPS = [
  {
    name: "ingest",
    entry: "apps/ingest/src/server.ts",
    // Only what ingest actually needs at runtime. A Cloud Run cold start
    // counts against GitHub's ~10s delivery timeout, so this list stays short.
    deps: {
      hono: "^4.9.10",
      "@hono/node-server": "^1.19.5",
      pg: "^8.23.0",
      zod: "^4.5.4",
      dotenv: "^17.2.1",
      "@google-cloud/pubsub": "^6.0.1",
      "@google-cloud/secret-manager": "^7.0.0",
    },
  },
  {
    name: "orchestrator",
    entry: "apps/orchestrator/src/worker.ts",
    deps: {
      "@google/adk": "^2.0.0",
      "@google/genai": "^2.20.0",
      "@octokit/rest": "^22.0.1",
      "@kubernetes/client-node": "^1.4.0",
      "ts-morph": "^28.0.0",
      pg: "^8.23.0",
      zod: "^4.5.4",
      dotenv: "^17.2.1",
      "@google-cloud/pubsub": "^6.0.1",
      "@google-cloud/secret-manager": "^7.0.0",
    },
  },
];

await mkdir("dist", { recursive: true });

for (const app of APPS) {
  const outfile = `dist/${app.name}/index.js`;

  await build({
    entryPoints: [app.entry],
    outfile,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    /**
     * `packages: "external"` is too blunt here: it externalises EVERY bare
     * import, including the workspace packages, so the bundle shipped an
     * `import "@srectl/core"` that nothing in the image provides. Cloud Run
     * reported it as "container failed to listen on PORT", which names the
     * symptom and not the cause.
     *
     * This resolves the distinction explicitly: workspace code is bundled,
     * everything else stays external and is installed from the generated
     * package.json.
     */
    plugins: [
      {
        name: "externalize-third-party",
        setup(build) {
          build.onResolve({ filter: /^[^.\/]|^@/ }, (args) => {
            if (args.path.startsWith("@srectl/")) return null; // bundle it
            if (args.path.startsWith("node:")) return { path: args.path, external: true };
            return { path: args.path, external: true };
          });
        },
      },
    ],
    sourcemap: true,
    // ESM bundles lose the CJS globals some dependencies still reach for.
    banner: {
      js: [
        "import { createRequire as __createRequire } from 'node:module';",
        "const require = __createRequire(import.meta.url);",
      ].join("\n"),
    },
    logLevel: "warning",
  });

  await writeFile(
    `dist/${app.name}/package.json`,
    JSON.stringify(
      { name: `srectl-${app.name}`, private: true, type: "module", dependencies: app.deps },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  console.log(`built dist/${app.name}/`);
}

console.log("\nBundled. The images install only the runtime dependencies listed above.");
