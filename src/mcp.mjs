/**
 * Optional MCP server wiring: lets QVAC call tools from a Model Context Protocol
 * server directly via `completion({ mcp })`, instead of (or alongside) the v0
 * JSON-action protocol in tools.mjs.
 *
 * Config is a JSON file, same shape as policy.json/address-book.json: the file is
 * optional, and no file means no MCP servers and byte-identical behavior to
 * before. Point NAD_MCP_CONFIG elsewhere, or use the default mcp.json next to .env.
 *
 *   { "servers": [ { "name": "wdk-wallet", "command": "npx",
 *                     "args": ["-y", "@tetherto/wdk-mcp-toolkit"] } ] }
 *
 * @tetherto/wdk-mcp-toolkit (the 35-tool wallet server referenced in the README's
 * "Upgrade path") is reserved on npm but has not shipped real code yet — this file
 * wires any MCP server generically over stdio, so pointing `command`/`args` at the
 * real package will work the moment it ships, with no code changes here.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_PATH = fileURLToPath(new URL("../mcp.json", import.meta.url));

/**
 * Load and validate mcp.json (override with NAD_MCP_CONFIG). Returns null when no
 * file exists. Throws on a malformed config: same "fail closed, never silently
 * run with a broken setup" rule as loadPolicy().
 */
export function loadMcpConfig(path = process.env.NAD_MCP_CONFIG || DEFAULT_PATH) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error(`mcp config ${path} could not be read: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`mcp config ${path} is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`mcp config ${path} must contain a JSON object`);
  }

  const KNOWN_KEYS = new Set(["servers"]);
  const unknown = Object.keys(parsed).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length) {
    throw new Error(`mcp config ${path} contains unknown key${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
  }
  if (!Array.isArray(parsed.servers) || parsed.servers.length === 0) {
    throw new Error(`mcp config ${path} must list at least one server under "servers"`);
  }

  const seen = new Set();
  const servers = parsed.servers.map((s, i) => {
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      throw new Error(`mcp config ${path}: servers[${i}] must be an object`);
    }
    if (typeof s.name !== "string" || !s.name.trim()) {
      throw new Error(`mcp config ${path}: servers[${i}] is missing "name"`);
    }
    if (typeof s.command !== "string" || !s.command.trim()) {
      throw new Error(`mcp config ${path}: servers[${i}] ("${s.name}") is missing "command"`);
    }
    const args = s.args ?? [];
    if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
      throw new Error(`mcp config ${path}: servers[${i}] ("${s.name}") "args" must be an array of strings`);
    }
    const env = s.env ?? {};
    if (typeof env !== "object" || env === null || Array.isArray(env) || !Object.values(env).every((v) => typeof v === "string")) {
      throw new Error(`mcp config ${path}: servers[${i}] ("${s.name}") "env" must be an object of strings`);
    }
    if (seen.has(s.name)) {
      throw new Error(`mcp config ${path}: duplicate server name "${s.name}"`);
    }
    seen.add(s.name);
    return { name: s.name, command: s.command, args, env };
  });

  return { path, servers };
}

// Kept external from any bundle and imported lazily, same rule as QVAC in
// agent.mjs: nad-agent must still run (build, doctor, slash-commands) for
// everyone who has not opted into MCP by writing an mcp.json.
const mcpClientModule = () => import("@modelcontextprotocol/sdk/client/index.js");
const mcpStdioModule = () => import("@modelcontextprotocol/sdk/client/stdio.js");

/**
 * Connect to every configured server over stdio. Best-effort, like loadBrain():
 * a server that fails to start is reported via onWarn and skipped rather than
 * stopping the whole agent — the rest of the toolset (slash-commands, other
 * servers) still works.
 */
export async function connectMcpServers(servers, { onWarn } = {}) {
  const { Client } = await mcpClientModule();
  const { StdioClientTransport } = await mcpStdioModule();
  const connected = [];
  for (const s of servers) {
    try {
      const client = new Client({ name: `nad-agent (${s.name})`, version: "1.0.0" });
      const transport = new StdioClientTransport({
        command: s.command,
        args: s.args,
        env: { ...process.env, ...s.env },
      });
      await client.connect(transport);
      connected.push({ name: s.name, client });
    } catch (err) {
      onWarn?.(`MCP server "${s.name}" failed to connect: ${err.message}`);
    }
  }
  return connected;
}

/** Close every connected client. Best-effort — a stuck server must not block exit. */
export async function disconnectMcpServers(connected) {
  await Promise.all(
    connected.map(({ client }) => Promise.resolve(client.close()).catch(() => {})),
  );
}

/**
 * Turn an MCP tool result (arbitrary JSON per the server — usually
 * `{ content: [{ type: "text", text }], isError? }`) into a bounded string for
 * conversation history. Unknown shapes fall back to JSON, and everything is
 * capped: a tool result reaches both the model's context and the terminal, and
 * neither should be handed an unbounded blob from a server nad-agent does not
 * control.
 */
export function summarizeMcpToolResult(result, maxLen = 4000) {
  let text;
  if (result && typeof result === "object" && Array.isArray(result.content)) {
    text = result.content
      .filter((c) => c && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
    if (!text) text = JSON.stringify(result);
  } else {
    text = typeof result === "string" ? result : JSON.stringify(result);
  }
  return text.length > maxLen ? `${text.slice(0, maxLen)}...(truncated)` : text;
}
