/**
 * Test double for `@qvac/sdk`, injected into a REAL CLI subprocess via the
 * loader hook in shim-hooks.mjs (installed by shim-register.mjs, loaded with
 * `node --import <shim-register> dist/cli.mjs`).
 *
 * Only the model is faked — wallet init (dry-run), policy, history, the native
 * tool loop, the MCP turn, confirm prompts and `process.exit` are all
 * production code, so a scripted run through this shim verifies the actual CLI
 * exit path with no live model, no GPU and no funded wallet.
 *
 * One scenario per process, selected via NAD_SHIM_SCENARIO (read lazily at each
 * completion call so the turn counter drives multi-turn cases):
 *   ok           — one get_address tool call, then a text-only turn (exit 0)
 *   refusal      — get_nfts with a bad address (dispatch returns Refused),
 *                  then a text-only turn (exit 1 — the refusal must stick)
 *   sdk-error    — a toolError event with a fixed message (exit 1)
 *   turn-exhaust — a get_address tool call on EVERY turn (exit 1 via turn limit)
 *
 * The mcp-* scenarios drive the MCP branch of processLine (an mcp.json with a
 * connected server is the harness's job, not this file's):
 *   mcp-chat     — text only; the turn must complete with exit 0
 *   mcp-read     — calls the BUILT-IN get_address while MCP is connected; the
 *                  read must answer from our own dispatch (issue #118: with a
 *                  server connected, built-in tools used to vanish, so the
 *                  model could not reach them at all)
 *   mcp-refusal  — calls the BUILT-IN send_mon to an unknown recipient; the
 *                  real handleAction boundary refuses it (exit 1)
 *   mcp-gate     — calls the server's srv_do_thing; the confirmation gate has
 *                  no scripted answer line left, so it must decline WITHOUT
 *                  invoking the server (exit 1)
 *   mcp-accept   — same call, but the scripted `y` approves it: the gate must
 *                  reach the real server (exit 0)
 *
 * Every mcp-* response reports what the request actually carried
 * (`… tools=<n> mcp=<n>`), so a test can prove from inside the real process
 * that the built-in definitions and the servers were offered together.
 *
 * Unlike completeWithTools, completeWithMcp reads `run.final` (contentText +
 * toolCalls) instead of collecting tool calls from the event stream, so every
 * completion returns both halves.
 *
 * NAD_SHIM_CALL_LOG, when set, names a file that gets one line per completion() call, so a test
 * can prove a command never reached the model (slash commands must not).
 */
import { appendFileSync } from "node:fs";

let calls = 0;

const DELTA = (text) => ({ type: "contentDelta", seq: 0, text });
const TEXT_ONLY = (text) => ({
  events: [DELTA(text)],
  final: { contentText: text, toolCalls: [] },
});

/** Events for the non-MCP scenarios (`n` is 1-based, one per completion call). */
function nativeEvents(scenario, n) {
  switch (scenario) {
    case "sdk-error":
      return [
        {
          type: "toolError",
          seq: 0,
          error: { code: "VALIDATION_ERROR", message: "shim SDK says no: bad tool arguments" },
        },
      ];
    case "turn-exhaust":
      return [
        {
          type: "toolCall",
          seq: 0,
          call: { id: `shim_${n}`, name: "get_address", arguments: {} },
        },
      ];
    case "refusal":
      if (n === 1) {
        return [
          {
            type: "toolCall",
            seq: 0,
            call: { id: "shim_r1", name: "get_nfts", arguments: { address: "not-an-address" } },
          },
        ];
      }
      return [DELTA("Noted.")];
    case "ok":
    default:
      if (n === 1) {
        return [
          {
            type: "toolCall",
            seq: 0,
            call: { id: "shim_ok", name: "get_address", arguments: {} },
          },
        ];
      }
      return [DELTA("Done.")];
  }
}

/** One completion for the MCP scenarios — see the header for each contract. */
function mcpCompletion(scenario, n, params) {
  // Report what this request actually carried, so a test can prove (from
  // inside the real process) that our tools and the servers' were offered
  // together — the whole of issue #118.
  const counts = `tools=${params.tools?.length ?? 0} mcp=${params.mcp?.length ?? 0}`;
  if (scenario === "mcp-chat") return TEXT_ONLY(`Hello from the MCP branch. ${counts}`);
  if (n > 1) return TEXT_ONLY(`Done. ${counts}`);
  const firstCalls = {
    "mcp-read": { id: "shim_mread", name: "get_address", arguments: {} },
    "mcp-refusal": { id: "shim_mref", name: "send_mon", arguments: { to: "nobody-in-the-book", amountMon: "1" } },
    "mcp-gate": { id: "shim_mgate", name: "srv_do_thing", arguments: { x: 1 } },
    "mcp-accept": { id: "shim_macc", name: "srv_do_thing", arguments: { x: 1 } },
  };
  const call = { ...firstCalls[scenario] };
  if (scenario === "mcp-accept") {
    // The real SDK attaches `invoke` to a server's tool call (mcp-adapter's
    // handler is `client.callTool`). Our fake replaces that stream, so attach
    // the same contract here — otherwise the gate would find no handler and
    // the approve branch could never be exercised. It really does dial the
    // server (same config, same stdio transport), so a test can assert the
    // round trip happened.
    call.invoke = async () => {
      const { loadMcpConfig, connectMcpServers, disconnectMcpServers } = await import("../../src/mcp.mjs");
      const cfg = loadMcpConfig();
      const connected = await connectMcpServers(cfg.servers, { onWarn: () => {} });
      try {
        return await connected[0].client.callTool({ name: call.name, arguments: call.arguments });
      } finally {
        await disconnectMcpServers(connected);
      }
    };
  }
  return { events: [], final: { contentText: "", toolCalls: [call] } };
}

export async function loadModel(_params, _opts) {
  return "shim-model-id";
}

export async function unloadModel(_params) {
  return null;
}

export function completion(params, _opts) {
  if (process.env.NAD_SHIM_CALL_LOG) appendFileSync(process.env.NAD_SHIM_CALL_LOG, "completion\n");
  const scenario = process.env.NAD_SHIM_SCENARIO || "ok";
  calls++;
  const { events, final } = scenario.startsWith("mcp-")
    ? mcpCompletion(scenario, calls, params)
    : { events: nativeEvents(scenario, calls), final: { contentText: "", toolCalls: [] } };
  return {
    events: (async function* () {
      for (const e of events) yield e;
    })(),
    final: Promise.resolve(final),
  };
}
