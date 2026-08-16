/**
 * Preflight check — run this first on a new machine (`npm run doctor`).
 * Verifies platform, Node, deps, env, and model availability without loading
 * anything heavy. Great for confirming a fresh `git pull` + `npm install` on the Mac.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ok = (m) => console.log(`  ✓ ${m}`);
const warn = (m) => console.log(`  ! ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);

console.log("\nnad-agent doctor\n");

// Platform / Node
console.log(`platform: ${process.platform}-${process.arch}, node ${process.version}`);
const major = Number(process.version.slice(1).split(".")[0]);
major >= 22 ? ok("Node >= 22") : bad(`Node ${process.version} — QVAC needs >= 22.17`);
if (process.platform === "darwin" && process.arch === "arm64") ok("Apple Silicon — QVAC can use Metal");

// Dependencies present?
console.log("\ndependencies:");
for (const pkg of ["@qvac/sdk", "@tetherto/wdk", "@tetherto/wdk-wallet-evm-erc-4337", "ethers"]) {
  try {
    require.resolve(pkg);
    ok(pkg);
  } catch {
    bad(`${pkg} — run \`npm install\``);
  }
}

// Build output?
console.log("\nbuild:");
existsSync("dist/cli.mjs") ? ok("dist/cli.mjs") : warn("not built — run `npm run build`");

// Env
console.log("\nenv (.env):");
existsSync(".env") ? ok(".env present") : warn(".env missing — `cp .env.example .env`");
// The seed the agent will use comes from the environment (`npm start` loads
// .env via --env-file). Doctor must run on ANY Node — including one too old
// for that flag — so when the variable is not exported it falls back to a
// light read of .env itself rather than relying on flag support.
let seed = process.env.WDK_SEED;
if (!seed && existsSync(".env")) {
  const line = readFileSync(".env", "utf8").match(/^\s*WDK_SEED\s*=\s*(.*)$/m);
  if (line) seed = line[1].trim().replace(/^(["'])(.*)\1$/, "$2");
}
if (!seed) {
  warn("WDK_SEED not set — `npm run gen-seed`");
} else {
  // A typo'd seed used to surface much later, as a confusing initWallet failure.
  // Validate the shape here — without deriving or printing anything sensitive.
  const words = seed.trim().split(/\s+/);
  if (words.length !== 24) {
    warn(`WDK_SEED is set but has ${words.length} word${words.length === 1 ? "" : "s"}, not 24 — check for a paste error`);
  } else {
    let checksum = null;
    try {
      const { Mnemonic } = await import("ethers");
      // Joined on single spaces: stray double spaces are a formatting quirk,
      // not a typo'd word, and must not fail the checksum.
      checksum = Mnemonic.isValidMnemonic(words.join(" "));
    } catch {
      /* ethers missing is already reported under dependencies */
    }
    if (checksum === false) warn("WDK_SEED has 24 words but the BIP-39 checksum fails — likely a typo'd word");
    else ok(`WDK_SEED: 24 words${checksum ? ", BIP-39 checksum valid" : ""}`);
  }
}
if (process.env.PIMLICO_API_KEY) ok("PIMLICO_API_KEY set — real sends enabled");
else warn("PIMLICO_API_KEY not set — will run in DRY-RUN (sends simulated)");

// Network — one eth_chainId round-trip, short timeout. A dead RPC used to
// surface later as a confusing initWallet failure; doctor should say it first.
// Offline is a warning, never a crash: doctor must complete without a network.
console.log("\nnetwork:");
try {
  const { config } = await import("../src/config.mjs");
  const { rpcUrl, chainId, name } = config.chain;
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(4000),
    });
    // Parse failures are their own case: an HTML page on the URL is reachable,
    // just not an RPC — "unreachable" would send someone debugging the network.
    let payload = null;
    try { payload = await res.json(); } catch { /* not JSON */ }
    const got = Number(payload?.result);
    if (!Number.isFinite(got)) warn(`RPC ${rpcUrl} answered, but not with a chainId — is this a JSON-RPC endpoint?`);
    else if (got === chainId) ok(`RPC reachable, chainId ${got} matches ${name}`);
    else bad(`RPC reachable, but chainId ${got} does not match ${name} (expected ${chainId}) — check MONAD_NETWORK / MONAD_RPC_URL`);
  } catch {
    warn(`RPC ${rpcUrl} unreachable within 4s — reads and sends will fail until it is`);
  }
} catch (err) {
  warn(`network config could not be resolved: ${err.message}`);
}

// Model
console.log("\nmodel:");
const model = process.env.QVAC_MODEL_PATH || process.env.QVAC_MODEL || "QWEN3_8B_INST_Q4_K_M";
if (process.env.QVAC_MODEL_PATH) {
  existsSync(process.env.QVAC_MODEL_PATH)
    ? ok(`local GGUF: ${process.env.QVAC_MODEL_PATH}`)
    : bad(`QVAC_MODEL_PATH points at a missing file: ${process.env.QVAC_MODEL_PATH}`);
} else {
  ok(`registry model: ${model} (downloaded on first run)`);
}

console.log("\ndone.\n");
