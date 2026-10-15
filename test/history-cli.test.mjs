/**
 * Run the real CLI startup, slash dispatch and exit path with fixed wallet/model
 * boundaries. Capture the streams separately: a combined transcript hides #129.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "nad-history-cli-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const OWNER = "0x1111111111111111111111111111111111111111";
const IN_HASH = `0x${"a".repeat(64)}`;
const OUT_HASH = `0x${"b".repeat(64)}`;
const TX_URL = `https://testnet.monadscan.com/tx/${IN_HASH}`;

// Intercept both the CLI's and tools.mjs's wallet imports. Everything else,
// including formatting, configuration and the read-command dispatch, is real.
const wallet = `
  export const initWallet = async () => ${JSON.stringify(OWNER)};
  export const getAddress = () => ${JSON.stringify(OWNER)};
  export const getBalance = async () => 2000000000000000000n;
  export const dispose = () => {};
  export async function getHistory() {
    if (process.env.NAD_TEST_HISTORY === "failure") throw new Error("explorer unavailable");
    if (process.env.NAD_TEST_HISTORY === "empty") return [];
    if (process.env.NAD_TEST_HISTORY !== "rows") throw new Error("unexpected history read");
    return [
      { direction: "in", amount: 1250000000000000000n,
        hash: ${JSON.stringify(IN_HASH)}, explorerUrl: ${JSON.stringify(TX_URL)} },
      { direction: "out", amount: 0n, hash: ${JSON.stringify(OUT_HASH)} },
    ];
  }
`;
const brain = `
  export const loadBrain = async () => {};
  export const unloadBrain = async () => {};
  export const complete = async () => { throw new Error("slash command reached model"); };
`;
const hooks = join(dir, "hooks.mjs");
writeFileSync(hooks, `
  const fixtures = new Map(${JSON.stringify([
    [new URL("../src/wallet.mjs", import.meta.url).href, wallet],
    [new URL("../src/agent.mjs", import.meta.url).href, brain],
  ])});
  export async function resolve(specifier, context, nextResolve) {
    const resolved = await nextResolve(specifier, context);
    const fixture = fixtures.get(resolved.url);
    return fixture === undefined ? resolved : {
      url: "data:text/javascript," + encodeURIComponent(fixture), shortCircuit: true,
    };
  }
`);
const register = join(dir, "register.mjs");
writeFileSync(register, `import { register } from "node:module";
register(${JSON.stringify(pathToFileURL(hooks).href)});
// Any accidental network access must fail the test, never contact a real service.
globalThis.fetch = async () => { throw new Error("unexpected network request"); };
`);
const policy = join(dir, "policy.json");
writeFileSync(policy, "{}");

function runCli(input, scenario = "rows") {
  const env = {
    ...process.env,
    NAD_TEST_HISTORY: scenario,
    NAD_STATE_PATH: join(dir, "state.json"),
    NAD_POLICY: policy,
    NAD_MCP_CONFIG: join(dir, "no-mcp.json"),
    NAD_ADDRESS_BOOK: join(dir, "no-address-book.json"),
    MONAD_NETWORK: "testnet",
    WDK_GAS_MODE: "dry-run",
    QVAC_MODEL_PATH: "fixture-model.gguf",
    USE_NATIVE_TOOLS: "false",
    NO_COLOR: "1",
  };
  delete env.NAD_CLI_NO_RUN;
  delete env.PIMLICO_API_KEY;
  delete env.PIMLICO_SPONSORSHIP_POLICY_ID;
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(register).href, CLI], {
    env, input, encoding: "utf8", timeout: 15_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.match(result.stderr, /initializing wallet/);
  assert.doesNotMatch(result.stdout + result.stderr, /unexpected network request|slash command reached model/);
  assert.doesNotMatch(result.stdout + result.stderr, /\x1b\[/);
  return result;
}

const ROWS = "  recent transactions\n" +
  `  in  +1.25 MON  ${IN_HASH}\n       ${TX_URL}\n` +
  `  out -0.0 MON  ${OUT_HASH}\n\n`;
const EMPTY = "  no recent transactions found.\n\n";
const ADDRESS = `  ${OWNER}\n\n`;

describe("/history output streams through the CLI", () => {
  test("prints successful rows and links only to stdout", () => {
    const r = runCli("/history\n");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, ROWS);
    assert.doesNotMatch(r.stderr, /recent transactions|0x[a-b]{64}|monadscan\.com\/tx\//);
  });

  test("prints the successful empty-history result only to stdout", () => {
    const r = runCli("/history\n", "empty");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, EMPTY);
    assert.doesNotMatch(r.stderr, /no recent transactions found/);
  });

  test("keeps fetch failures on stderr with a failing exit", () => {
    const r = runCli("/history\n", "failure");
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /history error: explorer unavailable/);
    assert.doesNotMatch(r.stderr, /no recent transactions found/);
  });

  test("rejects extra arguments before fetching history", () => {
    const r = runCli("/history extra\n", "not-called");
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /usage: \/history/);
    assert.doesNotMatch(r.stderr, /history error|unexpected history read/);
  });

  test("preserves results and ordering alongside other read commands", () => {
    const r = runCli("/history\n/address\n/balance\n");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, ROWS + ADDRESS + "  2.0 MON\n\n");
  });

  test("a successful read after a history failure does not clear the failing exit", () => {
    const r = runCli("/history\n/address\n", "failure");
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stdout, ADDRESS);
    assert.match(r.stderr, /history error: explorer unavailable/);
  });
});
