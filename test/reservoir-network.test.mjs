/**
 * The Reservoir host must follow MONAD_NETWORK (Issue #63).
 *
 * config.mjs reads the environment once at import time, so each case runs in its own
 * child process — re-importing in-process would hand back the cached module.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const CONFIG_URL = new URL("../src/config.mjs", import.meta.url).href;
const TOOLS_URL = new URL("../src/tools.mjs", import.meta.url).href;

/** Import config.mjs in a fresh process with `env` applied, and return config.reservoirUrl. */
function reservoirUrlWith(env) {
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", `const { config } = await import(${JSON.stringify(CONFIG_URL)}); process.stdout.write(config.reservoirUrl);`],
    { env: { ...process.env, RESERVOIR_API_URL: "", MONAD_NETWORK: "", ...env }, encoding: "utf8" },
  );
  return out.trim();
}

test("testnet defaults to Reservoir's Monad testnet host", () => {
  assert.equal(reservoirUrlWith({ MONAD_NETWORK: "testnet" }), "https://api-monad-testnet.reservoir.tools");
});

test("mainnet does NOT fall back to the testnet host", () => {
  // The whole point of the issue: a mainnet run must not answer from testnet data.
  assert.equal(reservoirUrlWith({ MONAD_NETWORK: "mainnet" }), "");
});

test("RESERVOIR_API_URL overrides the network default on both networks", () => {
  const custom = "https://indexer.example/api";
  assert.equal(reservoirUrlWith({ MONAD_NETWORK: "mainnet", RESERVOIR_API_URL: custom }), custom);
  assert.equal(reservoirUrlWith({ MONAD_NETWORK: "testnet", RESERVOIR_API_URL: custom }), custom);
});

test("get_nfts is refused on mainnet instead of reading another chain", async () => {
  // Runs in a child process so MONAD_NETWORK=mainnet is in place before config loads.
  // A key is set so the refusal can only come from the missing host, not the missing key.
  const script = `
    const { runAction } = await import(${JSON.stringify(TOOLS_URL)});
    process.stdout.write(String(await runAction({ action: "get_nfts", address: "0x8ba1f109551bD432803012645Ac136ddd64DBA72" }).catch((e) => e.message)));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, MONAD_NETWORK: "mainnet", RESERVOIR_API_URL: "", RESERVOIR_API_KEY: "test-key" },
    encoding: "utf8",
  });
  assert.match(out, /^Refused:/);
  assert.match(out, /RESERVOIR_API_URL/);
});
