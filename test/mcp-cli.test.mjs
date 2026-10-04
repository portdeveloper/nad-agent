/**
 * Real CLI subprocess with an MCP server connected (issue #118).
 *
 * The bug was reachable only through THIS configuration: mcp.json present, so
 * processLine took the MCP branch, and every line went to completeWithMcp —
 * which completed with `{ mcp }` alone. The nine built-in wallet tools the
 * system prompt advertises were never offered, a wallet request became a
 * no-op, and a scripted run still exited 0.
 *
 * The loop-level file (mcp-native-dispatch.test.mjs) pins the routing in
 * process; these run dist/cli.mjs end to end — real MCP handshake with a real
 * stdio server (test/helpers/mcp-stdio-server.mjs), real handleAction, real
 * confirmation gate, real `process.exit(hadFailure ? 1 : 0)` — and so cover the
 * wiring in src/cli.mjs itself:
 *
 *   mcp-chat    — server connects, a plain turn completes, exit 0, and the
 *                 request carried tools AND mcp together (reported by the shim).
 *   mcp-read    — a built-in read answers from our own dispatch, not the gate.
 *   mcp-refusal — a built-in write is refused by handleAction → exit 1.
 *   mcp-gate    — a server tool is declined by the confirmation gate before
 *                 the server is ever called → exit 1.
 *   mcp-accept  — the same server tool, approved by a scripted `y`, reaches the
 *                 real server → exit 0 (the positive control for the refusals).
 *
 * Offline: only the model is faked (loader hook → test/helpers/shim-qvac.mjs),
 * no live model, no GPU, no funded wallet, no network beyond localhost.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHIM_REGISTER = fileURLToPath(new URL("./helpers/shim-register.mjs", import.meta.url));
const MCP_SERVER = fileURLToPath(new URL("./helpers/mcp-stdio-server.mjs", import.meta.url));
const DIST_CLI = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
// --import must be a file:// URL: a bare absolute path is rejected by the ESM
// loader on Windows (ERR_UNSUPPORTED_ESM_URL_SCHEME).
const SHIM_REGISTER_URL = pathToFileURL(SHIM_REGISTER).href;

// Standard BIP-39 test vector — valid checksum, never funded. initWallet only
// derives locally from it (dry-run); the startup balance read is best-effort.
const TEST_SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const stateDir = mkdtempSync(join(tmpdir(), "nad-mcp-cli-"));
const EMPTY_POLICY = join(stateDir, "empty-policy.json");
writeFileSync(EMPTY_POLICY, "{}");

function runMcpCli(scenario, { input = "hello\n" } = {}) {
  assert.ok(existsSync(DIST_CLI), "dist/cli.mjs missing — run npm run build first (CI builds before testing)");
  const callLog = join(stateDir, `server-calls-${scenario}.log`);
  rmSync(callLog, { force: true });
  // The call-log path goes in the SERVER's env map, not the CLI's: the stdio
  // transport only forwards a whitelist of the parent's environment.
  const mcpConfig = join(stateDir, `mcp-${scenario}.json`);
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      servers: [
        { name: "t", command: process.execPath, args: [MCP_SERVER], env: { NAD_MCP_CALL_LOG: callLog } },
      ],
    }),
  );
  const env = {
    ...process.env,
    WDK_SEED: TEST_SEED,
    QVAC_MODEL_PATH: "shim-model.gguf", // consumed by the shim, never read
    USE_NATIVE_TOOLS: "true",
    MONAD_NETWORK: "testnet",
    NAD_STATE_PATH: join(stateDir, `${scenario}.json`),
    NAD_POLICY: EMPTY_POLICY,
    NAD_MCP_CONFIG: mcpConfig,
    NAD_SHIM_SCENARIO: scenario,
    NO_COLOR: "1",
  };
  delete env.NAD_CLI_NO_RUN; // this file never sets it; the child must REALLY run
  delete env.PIMLICO_API_KEY; // force dry-run regardless of the developer shell
  delete env.PIMLICO_SPONSORSHIP_POLICY_ID;
  // spawnSync, not execFileSync: stderr holds the whole scripted transcript and
  // must be captured on success too, not only when the child throws.
  const res = spawnSync(process.execPath, ["--import", SHIM_REGISTER_URL, DIST_CLI], {
    env,
    input, // scripted lines; the shimmed model ignores their content
    encoding: "utf8",
    timeout: 120000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  assert.equal(res.error, undefined, `child failed to run: ${res.error?.message}`);
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    log: `${res.stdout ?? ""}${res.stderr ?? ""}`,
    callLog,
  };
}

/** Lines the fake MCP server actually executed (absent → never called). */
function serverCalls(callLog) {
  if (!existsSync(callLog)) return [];
  return readFileSync(callLog, "utf8").split("\n").filter(Boolean);
}

describe("real CLI subprocess — MCP server connected (issue #118)", () => {
  test("the server connects and a plain turn exits 0 with tools AND mcp in the request", () => {
    const r = runMcpCli("mcp-chat");
    const log = r.log;
    assert.equal(r.status, 0, `expected exit 0, transcript:\n${log}`);
    assert.match(log, /ok \(1\/1\)/, "the configured server must have connected");
    // The shim reports what the completion request actually carried — the whole
    // of the bug: the built-in definitions and the servers, together, every time.
    assert.match(log, /Hello from the MCP branch\. tools=[1-9][0-9]* mcp=1/, `built-in tools must be offered alongside mcp:\n${log}`);
  });

  test("a built-in read is answered by our dispatch while MCP is connected", () => {
    const r = runMcpCli("mcp-read");
    const log = r.log;
    assert.equal(r.status, 0, `expected exit 0, transcript:\n${log}`);
    assert.match(log, /Done\. tools=[1-9][0-9]* mcp=1/, log);
    // Our boundary answered: the read result was printed, and the model's
    // request went nowhere near the confirmation gate.
    assert.ok(!log.includes("MCP tool: get_address"), "a built-in read must not hit the MCP gate");
    assert.ok(
      !log.includes("no handler is registered"),
      "the built-in tool must not be looked up on the server:\n" + log,
    );
    assert.match(log, /Read: your wallet address|0x[0-9a-fA-F]{40}|\(wallet not initialized\)/, log);
  });

  test("a built-in write is refused by handleAction → exit 1, server untouched", () => {
    const r = runMcpCli("mcp-refusal");
    const log = r.log;
    assert.equal(r.status, 1, `expected exit 1, transcript:\n${log}`);
    assert.match(log, /Refused:/, log);
    assert.match(log, /nobody-in-the-book/, "the recipient from the model's arguments must surface");
    // The write went through OUR boundary, not the server's tool catalog.
    assert.ok(!log.includes("MCP tool: send_mon"), "a built-in write must not hit the MCP gate");
    assert.deepEqual(serverCalls(r.callLog), [], "the server must not be called for a built-in action");
  });

  test("a server tool call is declined by the gate before the server runs → exit 1", () => {
    const r = runMcpCli("mcp-gate");
    const log = r.log;
    assert.equal(r.status, 1, `expected exit 1, transcript:\n${log}`);
    assert.match(log, /MCP tool: srv_do_thing/, "the server's tool must still reach the gate");
    // The gate asks, gets no answer line, cancels — the refusal is returned to
    // the model as a tool result (never printed), so the transcript shows the
    // cancel and the exit code carries the failure.
    assert.match(log, /no answer line for the confirmation/, log);
    assert.match(log, /cancelling this action/, log);
    // Scripted mode has no `y` left to give: the gate must cancel, and the
    // confirmation it never got must not be worth a single server round trip.
    assert.deepEqual(serverCalls(r.callLog), [], "a declined call must never reach the MCP server");
  });

  test("the same server tool, approved by a scripted y, reaches the real server → exit 0", () => {
    const r = runMcpCli("mcp-accept", { input: "hello\ny\n" });
    const log = r.log;
    assert.equal(r.status, 0, `expected exit 0, transcript:\n${log}`);
    assert.match(log, /allow this tool call\? \[y\/N\] y/, log);
    assert.match(log, /MCP TOOL RAN: srv_do_thing/, "the approved call must actually run on the server");
    assert.deepEqual(serverCalls(r.callLog), ["srv_do_thing"]);
  });
});
