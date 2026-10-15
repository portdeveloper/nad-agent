/**
 * WDK_GAS_MODE accepts the three values .env.example documents and refuses anything else.
 *
 * config.mjs reads the environment at import, so each case loads it in a child process, as
 * reservoir-network.test.mjs does. The CLI case runs the built dist/cli.mjs with the @qvac/sdk
 * shim, as nfts-command.test.mjs does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CONFIG_URL = pathToFileURL(fileURLToPath(new URL("../src/config.mjs", import.meta.url))).href;

/** gasMode and gasModeError for one environment, read in a fresh process. */
function load(env) {
  const script = `import(${JSON.stringify(CONFIG_URL)}).then(({ config }) =>
    console.log(JSON.stringify({ gasMode: config.gasMode, gasModeError: config.gasModeError })))`;
  const base = { ...process.env };
  delete base.WDK_GAS_MODE;
  delete base.PIMLICO_API_KEY;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...base, MONAD_NETWORK: "testnet", ...env },
    encoding: "utf8",
  });
  return JSON.parse(out.trim().split("\n").pop());
}

test("a typo of a gas mode is refused, never read as sponsored", () => {
  // On main each of these resolved to "sponsored" with a key set, which broadcasts.
  for (const value of ["dryrun", "dry_run", "simulate", "dry run", "gasless"]) {
    const r = load({ PIMLICO_API_KEY: "x", WDK_GAS_MODE: value });
    assert.ok(r.gasModeError, `${JSON.stringify(value)} must be refused`);
    assert.match(r.gasModeError, new RegExp(JSON.stringify(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(r.gasModeError, /dry-run, native or sponsored/);
    assert.equal(r.gasMode, "dry-run", "a refused value must not be able to broadcast");
  }
});

test("a refused value is refused without a key too", () => {
  const r = load({ WDK_GAS_MODE: "dryrun" });
  assert.ok(r.gasModeError);
  assert.equal(r.gasMode, "dry-run");
});

test("the documented values resolve as documented, in any case and with padding", () => {
  const cases = [
    ["dry-run", "dry-run"], ["DRY-RUN", "dry-run"], [" dry-run ", "dry-run"],
    ["native", "native"], ["Native", "native"],
    ["sponsored", "sponsored"], ["SPONSORED ", "sponsored"],
  ];
  for (const [value, mode] of cases) {
    const r = load({ PIMLICO_API_KEY: "x", WDK_GAS_MODE: value });
    assert.ok(!r.gasModeError, `${JSON.stringify(value)} is documented`);
    assert.equal(r.gasMode, mode, `${JSON.stringify(value)}`);
  }
});

test("an empty value keeps the auto-detection, with and without a key", () => {
  // Behaviour that must not change, so it holds on main as well.
  const cases = [
    [{ PIMLICO_API_KEY: "x" }, "sponsored"],
    [{ PIMLICO_API_KEY: "x", WDK_GAS_MODE: "" }, "sponsored"],
    [{}, "dry-run"],
    // Without a key every documented value still simulates, as before.
    [{ WDK_GAS_MODE: "sponsored" }, "dry-run"],
  ];
  for (const [env, mode] of cases) {
    const r = load(env);
    assert.ok(!r.gasModeError, JSON.stringify(env));
    assert.equal(r.gasMode, mode, JSON.stringify(env));
  }
});

test("the CLI stops before the banner or the wallet on every refused gas mode", () => {
  const distCli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
  assert.ok(existsSync(distCli), "dist/cli.mjs missing — run npm run build first (CI builds before testing)");
  const shim = pathToFileURL(fileURLToPath(new URL("./helpers/shim-register.mjs", import.meta.url))).href;
  const dir = mkdtempSync(join(tmpdir(), "nad-gas-"));
  const policy = join(dir, "policy.json");
  writeFileSync(policy, "{}");
  const callLog = join(dir, "calls.log");
  const env = {
    ...process.env,
    WDK_SEED: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    QVAC_MODEL_PATH: "shim-model.gguf",
    MONAD_NETWORK: "testnet",
    NAD_STATE_PATH: join(dir, "state.json"),
    NAD_POLICY: policy,
    NAD_MCP_CONFIG: join(dir, "no-mcp.json"),
    NAD_SHIM_CALL_LOG: callLog,
    NO_COLOR: "1",
    PIMLICO_API_KEY: "x",
  };
  delete env.NAD_CLI_NO_RUN;
  for (const value of ["dryrun", "dry_run", "simulate"]) {
    const r = spawnSync(process.execPath, ["--import", shim, distCli], {
      env: { ...env, WDK_GAS_MODE: value }, input: "/address\n", encoding: "utf8", timeout: 60_000,
    });
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 1, `${value}:\n${out}`);
    assert.ok(out.includes(`gas mode: WDK_GAS_MODE="${value}" is not a gas mode`), `${value}:\n${out}`);
    assert.doesNotMatch(out, /initializing wallet/, `${value}: the wallet must not be touched`);
    assert.doesNotMatch(out, /gasless/, `${value}: the banner must not claim a mode`);
  }
  const calls = existsSync(callLog) ? readFileSync(callLog, "utf8").split("\n").filter(Boolean).length : 0;
  assert.equal(calls, 0, "the model must not be called");
});
