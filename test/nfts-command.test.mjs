/**
 * `/nfts [address]` through the REAL CLI dispatch (Issue #116).
 *
 * Each case runs the built CLI (dist/cli.mjs) in scripted mode with the `@qvac/sdk` shim, so the
 * path under test is production code end to end: processLine → handleSlash → handleAction →
 * runAction(get_nfts) → the Reservoir read, and the scripted exit code. Only the model is faked,
 * and the shim's call log proves the slash command never reaches it.
 *
 * The indexer is a loopback server in this process. The child is spawned asynchronously (not
 * execFileSync) because a blocked event loop here would leave that server unable to answer.
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHIM_REGISTER_URL = pathToFileURL(
  fileURLToPath(new URL("./helpers/shim-register.mjs", import.meta.url))).href;
const DIST_CLI = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
// Standard BIP-39 test vector, never funded; the CLI only derives from it (dry-run).
const TEST_SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const OWNER = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";
const CONTRACT = "0x3333333333333333333333333333333333333333";

const dir = mkdtempSync(join(tmpdir(), "nad-nfts-"));
const EMPTY_POLICY = join(dir, "empty-policy.json");
writeFileSync(EMPTY_POLICY, "{}");

// Loopback Reservoir: answers one page and remembers which owner each request was for.
const owners = [];
const server = http.createServer((req, res) => {
  const m = req.url.match(/\/users\/(0x[0-9a-fA-F]{40})\/tokens\/v7/);
  if (m) owners.push(m[1]);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ tokens: [{ token: { contract: CONTRACT, tokenId: "7", name: "Fixture token" } }] }));
});
let indexer;
before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  indexer = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

let runs = 0;
/** Runs the real CLI with `lines` on stdin; resolves with the exit code, the transcript, and
 * how many times the model was asked for a completion. */
function runCli(lines, { network = "testnet", withIndexer = true } = {}) {
  assert.ok(existsSync(DIST_CLI), "dist/cli.mjs missing — run npm run build first (CI builds before testing)");
  const callLog = join(dir, `calls-${++runs}.log`);
  const env = {
    ...process.env,
    WDK_SEED: TEST_SEED,
    QVAC_MODEL_PATH: "shim-model.gguf",
    USE_NATIVE_TOOLS: "true",
    MONAD_NETWORK: network,
    NAD_STATE_PATH: join(dir, `state-${runs}.json`),
    NAD_POLICY: EMPTY_POLICY,
    NAD_MCP_CONFIG: join(dir, "no-mcp.json"),
    NAD_SHIM_CALL_LOG: callLog,
    NO_COLOR: "1",
  };
  delete env.NAD_CLI_NO_RUN;
  delete env.PIMLICO_API_KEY;
  delete env.PIMLICO_SPONSORSHIP_POLICY_ID;
  delete env.RESERVOIR_API_URL;
  delete env.RESERVOIR_API_KEY;
  if (withIndexer) {
    env.RESERVOIR_API_URL = indexer;
    env.RESERVOIR_API_KEY = "test-key";
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", SHIM_REGISTER_URL, DIST_CLI], { env });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI timed out:\n${out}`)); }, 120_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      const calls = existsSync(callLog) ? readFileSync(callLog, "utf8").split("\n").filter(Boolean).length : 0;
      resolve({ status, out, calls });
    });
    child.stdin.end(lines.join("\n") + "\n");
  });
}

describe("/nfts through the real CLI dispatch", () => {
  test("no address lists the active account's NFTs without asking the model", async () => {
    owners.length = 0;
    const r = await runCli(["/address", "/nfts"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.calls, 0, "a slash command must not reach the model");
    assert.equal(owners.length, 1, "exactly one indexer read");
    // The read is for the agent's own wallet: the address /address printed in the same run.
    assert.ok(r.out.includes(owners[0]), `indexer was asked about ${owners[0]}, which /address did not print:\n${r.out}`);
    assert.match(r.out, /Fixture token \(tokenId 7\)/);
  });

  test("an explicit address is the owner the indexer is asked about", async () => {
    owners.length = 0;
    const r = await runCli([`/nfts ${OWNER}`]);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.calls, 0);
    assert.deepEqual(owners, [OWNER]);
    assert.match(r.out, /Fixture token \(tokenId 7\)\s+contract: 0x3333333333333333333333333333333333333333/);
  });

  test("a malformed address is refused before any read, and fails the script", async () => {
    owners.length = 0;
    const r = await runCli(["/nfts not-an-address"]);
    assert.equal(r.status, 1, r.out);
    assert.equal(r.calls, 0);
    assert.equal(owners.length, 0, "no indexer read for a refused address");
    assert.match(r.out, /Refused: "not-an-address" is not a valid address\./);
  });

  test("extra arguments print the usage line and fail the script", async () => {
    owners.length = 0;
    const r = await runCli([`/nfts ${OWNER} extra`]);
    assert.equal(r.status, 1, r.out);
    assert.equal(r.calls, 0);
    assert.equal(owners.length, 0);
    assert.match(r.out, /usage: \/nfts \[address\]/);
  });

  test("with no indexer for the network, the refusal is shown and fails the script", async () => {
    // Monad mainnet has no Reservoir host, so without RESERVOIR_API_URL the read refuses.
    const r = await runCli(["/nfts"], { network: "mainnet", withIndexer: false });
    assert.equal(r.status, 1, r.out);
    assert.equal(r.calls, 0);
    assert.match(r.out, /Refused: no NFT indexer is configured/);
  });

  test("/help lists the command", async () => {
    const r = await runCli(["/help"]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /\/nfts \[address\]/);
  });
});
