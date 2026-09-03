import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
export default {
  // The workspace packages are TypeScript source, not built output.
  transpilePackages: ["@srectl/core"],

  /**
   * Standalone output, for the Cloud Run image, and only there.
   *
   * The alternative is copying the app plus node_modules, which in a pnpm
   * workspace means copying a tree of symlinks into the store - they resolve
   * to nothing once the store is not there. Standalone traces the modules
   * actually reached and emits real files.
   *
   * It is opt-in because emitting it needs to create symlinks, and Windows
   * refuses that without elevation or Developer Mode: enabling it
   * unconditionally makes `pnpm build` fail on the machine this is developed
   * on, with an EPERM that says nothing about Next.js. The Dockerfile builds
   * on Linux and sets NEXT_STANDALONE=1.
   *
   * outputFileTracingRoot has to be the workspace root, not this directory:
   * the tracer stops at the package boundary otherwise and leaves @srectl/core
   * out of the bundle, which fails at runtime rather than at build time.
   */
  ...(process.env.NEXT_STANDALONE === "1"
    ? {
        output: "standalone",
        outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
      }
    : {}),
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },

  webpack: (config) => {
    /**
     * The workspace packages are compiled with moduleResolution "nodenext",
     * which requires relative imports to carry a `.js` extension even though
     * the file on disk is `.ts`. Node and tsc understand that; webpack does
     * not, and fails with "Can't resolve './env.js'".
     */
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};
