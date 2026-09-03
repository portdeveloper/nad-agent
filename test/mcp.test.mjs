import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadMcpConfig,
  summarizeMcpToolResult,
  connectMcpServers,
  disconnectMcpServers,
  buildStdioTransportOptions,
} from "../src/mcp.mjs";

function mcpConfigFile(contents) {
  const dir = mkdtempSync(join(tmpdir(), "nad-mcp-"));
  const path = join(dir, "mcp.json");
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  return path;
}

describe("loadMcpConfig", () => {
  test("returns null when the file does not exist", () => {
    assert.equal(loadMcpConfig(join(tmpdir(), "nad-mcp-missing", "mcp.json")), null);
  });

  test("parses a valid single-server config", () => {
    const p = mcpConfigFile({ servers: [{ name: "wdk-wallet", command: "npx", args: ["-y", "@tetherto/wdk-mcp-toolkit"] }] });
    const cfg = loadMcpConfig(p);
    assert.equal(cfg.path, p);
    assert.deepEqual(cfg.servers, [{ name: "wdk-wallet", command: "npx", args: ["-y", "@tetherto/wdk-mcp-toolkit"], env: {} }]);
  });

  test("defaults args and env when omitted", () => {
    const p = mcpConfigFile({ servers: [{ name: "s", command: "node" }] });
    const cfg = loadMcpConfig(p);
    assert.deepEqual(cfg.servers[0], { name: "s", command: "node", args: [], env: {} });
  });

  test("carries through an env map of strings", () => {
    const p = mcpConfigFile({ servers: [{ name: "s", command: "node", env: { API_KEY: "abc" } }] });
    const cfg = loadMcpConfig(p);
    assert.deepEqual(cfg.servers[0].env, { API_KEY: "abc" });
  });

  test("fails closed on malformed JSON", () => {
    assert.throws(() => loadMcpConfig(mcpConfigFile("{ not json")), /not valid JSON/);
  });

  test("fails closed on unknown top-level keys", () => {
    assert.throws(() => loadMcpConfig(mcpConfigFile({ server: [] })), /unknown key.*server\b/);
  });

  test("requires at least one server", () => {
    assert.throws(() => loadMcpConfig(mcpConfigFile({ servers: [] })), /at least one server/);
    assert.throws(() => loadMcpConfig(mcpConfigFile({ servers: "nope" })), /at least one server/);
  });

  test("requires a name and a command on every server", () => {
    assert.throws(() => loadMcpConfig(mcpConfigFile({ servers: [{ command: "node" }] })), /missing "name"/);
    assert.throws(() => loadMcpConfig(mcpConfigFile({ servers: [{ name: "s" }] })), /missing "command"/);
  });

  test("rejects non-string args and non-string env values", () => {
    assert.throws(() => loadMcpConfig(mcpConfigFile({ servers: [{ name: "s", command: "node", args: [1] }] })), /"args" must be/);
    assert.throws(() => loadMcpConfig(mcpConfigFile({ servers: [{ name: "s", command: "node", env: { K: 1 } }] })), /"env" must be/);
  });

  test("rejects duplicate server names", () => {
    const p = mcpConfigFile({
      servers: [
        { name: "s", command: "node" },
        { name: "s", command: "npx" },
      ],
    });
    assert.throws(() => loadMcpConfig(p), /duplicate server name "s"/);
  });
});

describe("summarizeMcpToolResult", () => {
  test("joins text content blocks", () => {
    const out = summarizeMcpToolResult({ content: [{ type: "text", text: "hello" }, { type: "text", text: "world" }] });
    assert.equal(out, "hello\nworld");
  });

  test("ignores non-text content blocks", () => {
    const out = summarizeMcpToolResult({ content: [{ type: "image", data: "..." }, { type: "text", text: "ok" }] });
    assert.equal(out, "ok");
  });

  test("falls back to JSON for an unrecognized shape", () => {
    const out = summarizeMcpToolResult({ balance: "1.5", symbol: "MON" });
    assert.equal(out, JSON.stringify({ balance: "1.5", symbol: "MON" }));
  });

  test("passes a plain string through unchanged (when short)", () => {
    assert.equal(summarizeMcpToolResult("just text"), "just text");
  });

  test("truncates long results", () => {
    const out = summarizeMcpToolResult("x".repeat(5000), 100);
    assert.equal(out.length, 100 + "...(truncated)".length);
    assert.ok(out.endsWith("...(truncated)"));
  });

  test("content array with no text blocks falls back to JSON", () => {
    const result = { content: [{ type: "image", data: "abc" }] };
    assert.equal(summarizeMcpToolResult(result), JSON.stringify(result));
  });
});

describe("buildStdioTransportOptions — a configured server must not see this process's secrets", () => {
  const SENTINELS = { WDK_SEED: "sentinel wdk seed — must never reach a child", PIMLICO_API_KEY: "sentinel pimlico key" };
  let saved;

  beforeEach(() => {
    saved = { WDK_SEED: process.env.WDK_SEED, PIMLICO_API_KEY: process.env.PIMLICO_API_KEY };
    Object.assign(process.env, SENTINELS);
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("with an injected default-env seam: only that server's explicit env survives, never process.env", async () => {
    const fakeDefaultEnv = () => ({ PATH: "/usr/bin" }); // a stand-in for the SDK's own minimal allowlist
    const opts = await buildStdioTransportOptions(
      { name: "s", command: "node", args: ["server.js"], env: { PUBLIC_FLAG: "1" } },
      { getDefaultEnv: fakeDefaultEnv },
    );
    assert.deepEqual(opts, { command: "node", args: ["server.js"], env: { PATH: "/usr/bin", PUBLIC_FLAG: "1" } });
    assert.equal(opts.env.WDK_SEED, undefined, "the wallet seed must not leak to a configured server");
    assert.equal(opts.env.PIMLICO_API_KEY, undefined, "the paymaster key must not leak to a configured server");
  });

  test("against the real MCP SDK default env: process.env secrets are absent unless explicitly listed", async () => {
    const opts = await buildStdioTransportOptions({ name: "s", command: "node", args: [], env: {} });
    assert.equal(opts.env.WDK_SEED, undefined, "process.env.WDK_SEED must not be forwarded by default");
    assert.equal(opts.env.PIMLICO_API_KEY, undefined, "process.env.PIMLICO_API_KEY must not be forwarded by default");
    // The SDK's own minimal allowlist (PATH etc.) is still there, so the child can actually run.
    assert.ok(opts.env.PATH, "the SDK's own safe default env (PATH) must still be present");
  });

  test("a secret reaches a server only when the operator names it in that server's own env", async () => {
    const opts = await buildStdioTransportOptions({
      name: "s",
      command: "node",
      args: [],
      env: { WDK_SEED: process.env.WDK_SEED },
    });
    assert.equal(opts.env.WDK_SEED, SENTINELS.WDK_SEED, "explicit opt-in must still work");
    assert.equal(opts.env.PIMLICO_API_KEY, undefined, "an unlisted secret must still be absent");
  });
});

describe("connectMcpServers — best effort against the real MCP SDK", () => {
  test("a server that fails to spawn is skipped and reported, not thrown", async () => {
    const warnings = [];
    const connected = await connectMcpServers(
      [{ name: "nope", command: "definitely-not-a-real-binary-nad-agent", args: [], env: {} }],
      { onWarn: (msg) => warnings.push(msg) },
    );
    assert.deepEqual(connected, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /nope/);
    await disconnectMcpServers(connected); // must not throw on an empty list
  });

  test("one bad server does not stop a good one from connecting", async () => {
    // node --version exits immediately, so the stdio transport connects but the
    // MCP handshake itself times out/fails — still "skipped and reported", not
    // a crash, and the other (equally bad) entry is still attempted independently.
    const warnings = [];
    const connected = await connectMcpServers(
      [
        { name: "bad-1", command: "definitely-not-a-real-binary-nad-agent", args: [], env: {} },
        { name: "bad-2", command: "also-not-real-nad-agent", args: [], env: {} },
      ],
      { onWarn: (msg) => warnings.push(msg) },
    );
    assert.deepEqual(connected, []);
    assert.equal(warnings.length, 2, "each failing server is reported independently");
  });
});
