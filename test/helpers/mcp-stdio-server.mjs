/**
 * A minimal MCP server over stdio, for tests: answers `initialize`,
 * `tools/list` and `tools/call` so the real @modelcontextprotocol/sdk client
 * can connect, list one tool and call it — no network, no third-party package.
 *
 * One tool, `srv_do_thing`, whose name deliberately does NOT collide with any
 * built-in (dispatch routes by name, and a test needs both kinds in one turn).
 *
 * Anything else with an id gets an empty result, so a protocol addition on the
 * client side degrades to "empty" instead of hanging the handshake.
 *
 * NAD_MCP_CALL_LOG, when set, names a file that gets one line per `tools/call`
 * — a test can assert a declined call never reached the server.
 *
 * `node --test` executes every file under test/ (its default globs cover
 * **\/test/**), and with no client on stdin this loop would wait forever for a
 * handshake that never comes — wedging the whole suite. A real spawn (the CLI,
 * or a test connecting through connectMcpServers) has no NODE_TEST_CONTEXT in
 * the environment the stdio transport forwards, so it is only the discovery
 * pass that trips this.
 */
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.env.NODE_TEST_CONTEXT) process.exit(0);

const TOOL = {
  name: "srv_do_thing",
  description: "Test tool exposed by the fake MCP server.",
  inputSchema: { type: "object", properties: {}, required: [] },
};

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    continue;
  }
  const { id, method, params } = msg;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "nad-test-mcp", version: "1.0.0" },
      },
    });
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: [TOOL] } });
  } else if (method === "tools/call") {
    // A test can set NAD_MCP_CALL_LOG to prove the server was (or was NOT)
    // reached — the confirmation gate must never let a declined call through.
    if (process.env.NAD_MCP_CALL_LOG) {
      appendFileSync(process.env.NAD_MCP_CALL_LOG, `${params?.name ?? ""}\n`);
    }
    send({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: `MCP TOOL RAN: ${params?.name ?? ""}` }] },
    });
  } else if (id !== undefined && id !== null) {
    send({ jsonrpc: "2.0", id, result: {} });
  }
}
