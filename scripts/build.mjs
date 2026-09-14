/**
 * Bundle src/ -> dist/ with esbuild.
 *
 * Why a build step at all? WDK internally does `import { sodium_memzero } from
 * 'sodium-universal'` — a NAMED import from a CJS module, which throws under
 * Node's plain ESM loader. Bundling rewrites it into a working property access.
 *
 * The sodium alias below is THE subtle bit. WDK only uses `sodium_memzero`, which
 * pure-JS `sodium-javascript` provides — and it runs fine in the Node MAIN process
 * (it uses Node's `crypto`). So we alias sodium-native -> sodium-javascript, but
 * ONLY inside this bundle. We deliberately do NOT use a package.json `overrides`
 * (which is global): QVAC's separate Bare worker depends on the REAL native
 * sodium-native, and the pure-JS shim's `require('crypto')` aborts Bare (SIGABRT).
 * Bundle-scoped alias = WDK gets pure JS, QVAC (external) keeps the native addon.
 *
 * QVAC is NATIVE (Bare/llama.cpp prebuilds) and CANNOT be bundled — it's kept
 * external and resolves from node_modules at runtime, so each machine loads its
 * own prebuild (linux-arm64 here, darwin-arm64/Metal on an M4 Max).
 */

import { build } from "esbuild";
import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });

await build({
  entryPoints: ["src/cli.mjs", "src/e2e.mjs"],
  outdir: "dist",
  outExtension: { ".js": ".mjs" }, // outdir defaults to .js; keep .mjs naming
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // QVAC is native + spawns its own Bare worker — never bundle it.
  external: ["@qvac/sdk", "@qvac/*", "@modelcontextprotocol/*"],
  // Bundle-only: give WDK the pure-JS sodium (safe in the Node main process),
  // without touching the native sodium-native that QVAC's worker needs.
  alias: { "sodium-native": "sodium-javascript" },
  // Make CJS `require` available inside the ESM bundle (WDK deps use it).
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  logLevel: "info",
});

console.log("built -> dist/cli.mjs, dist/e2e.mjs");
