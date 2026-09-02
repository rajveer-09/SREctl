/** @type {import('next').NextConfig} */
export default {
  // The workspace packages are TypeScript source, not built output.
  transpilePackages: ["@srectl/core"],
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
