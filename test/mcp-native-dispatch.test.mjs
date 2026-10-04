/**
 * Combined MCP + built-in dispatch (issue #118).
 *
 * The bug: with an mcp.json present, processLine handed every line to
 * completeWithMcp, which completed with `{ mcp }` alone — so the nine built-in
 * wallet tools the system prompt advertises were never offered to the model,
 * and a wallet request became a no-op (scripted runs still exiting 0).
 *
 * Passing the definitions is only half of it, which is what these tests pin:
 *
 *   1. the completion receives `tools` AND `mcp` in one request;
 *   2. a built-in WRITE from that request reaches the REAL handleAction
 *      boundary (resolve → policy → confirm) and never the MCP gate;
 *   3. a built-in READ reaches dispatchToolCall, is printed once, and a
 *      refusal still fails a scripted run;
 *   4. an MCP tool call still reaches the confirmation gate — the gate is
 *      unchanged and refuses a call the operator has not approved;
 *   5. tool errors and a hit round limit fold into hadFailure, so the CLI's
 *      `process.exit(hadFailure ? 1 : 0)` mapping still sees them.
 *
 * Everything runs offline: only the model is faked (the runCompletion seam
 * the other native-tool tests use) — the loop, the boundary, the gate and the
 * exit mapping are production code.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

// Set BEFORE the dynamic cli.mjs import: importing the CLI without this flag
// starts the REPL (drains stdin, loads the model, calls process.exit).
process.env.NAD_CLI_NO_RUN = "1";
const cli = await import("../src/cli.mjs");
const { runMcpTurn, dispatchNativeCall } = await import("../src/nativeToolLoop.mjs");
const { completeWithMcp } = await import("../src/agent.mjs");
const { getToolDefinitions, dispatchToolCall, isWrite } = await import("../src/tools.mjs");

const noColor = {
  red: (s) => s, cyan: (s) => s, yellow: (s) => s, dim: (s) => s, bold: (s) => s,
  green: (s) => s, prompt: (s) => s, violet: (s) => s,
};

/** One fake completion(): replays `events`, then resolves `final`. */
function fakeRun({ events = [], final }) {
  return {
    events: (async function* () {
      for (const e of events) yield e;
    })(),
    final: Promise.resolve(final),
  };
}

/**
 * The exact production composition processLine now builds, with only the model
 * faked: real completeWithMcp → real handleAction → real dispatchToolCall →
 * real isWrite. `turns` replays in order (the last one repeats), and every
 * completion() params object is captured so a test can assert what the model
 * was offered.
 */
function makeTurn(turns, { handleAction, dispatchToolCall: dispatch, gate, printed }) {
  const seen = [];
  let i = 0;
  const runCompletion = (params) => {
    seen.push(params);
    const turn = turns[Math.min(i, turns.length - 1)];
    i++;
    return fakeRun(turn);
  };
  const hadFailure = { value: false };
  const history = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "the user's line" },
  ];
  const gateCalls = [];
  const run = () =>
    runMcpTurn({
      history,
      mcpClients: [{ name: "srv", client: {} }],
      completeWithMcp: (h, opts) => completeWithMcp(h, { ...opts, runCompletion }),
      getToolDefinitions,
      handleAction: handleAction ?? cli.handleAction,
      dispatchToolCall: dispatch ?? dispatchToolCall,
      isWrite,
      onToken: () => {},
      invokeToolCall: gate ?? (async (call) => { gateCalls.push(call); return "mcp result"; }),
      printw: () => {},
      DIM: "",
      RST: "",
      println: (...a) => printed.push(a.join("")),
      c: noColor,
      SCRIPTED: true,
      hadFailure,
    });
  return { seen, gateCalls, hadFailure, history, run };
}

const nativeToolCallTurn = (call) => ({
  events: [],
  final: { contentText: "", toolCalls: [call] },
});
const chatTurn = (text) => ({ events: [{ type: "contentDelta", text }], final: { contentText: text, toolCalls: [] } });

describe("MCP connected — the built-in tools are advertised alongside mcp", () => {
  test("every completion of the turn carries our tool definitions and the servers", async () => {
    const printed = [];
    const t = makeTurn(
      [nativeToolCallTurn({ id: "1", name: "get_address", arguments: {} }), chatTurn("done.")],
      { printed },
    );
    await t.run();

    assert.ok(t.seen.length >= 2, "the model must be re-completed after the tool result");
    for (const params of t.seen) {
      assert.ok(Array.isArray(params.tools), "tools must be passed to every completion");
      assert.deepEqual(
        params.tools.map((x) => x.name),
        getToolDefinitions().map((x) => x.name),
        "the advertised list must be the agent's own getToolDefinitions()",
      );
      assert.equal(params.mcp.length, 1, "the MCP server must stay in the same request");
    }
    // The prompt's promises and the model's catalogue agree again.
    for (const name of ["get_balance", "send_mon", "swap", "account", "transfer_nft"]) {
      assert.ok(getToolDefinitions().some((d) => d.name === name), `${name} missing from the advertised tools`);
    }
  });
});

describe("MCP connected — combined dispatch", () => {
  test("a built-in write reaches the REAL handleAction boundary, not the MCP gate", async () => {
    const printed = [];
    const t = makeTurn(
      [
        nativeToolCallTurn({ id: "1", name: "send_mon", arguments: { to: "nobody-in-the-book", amountMon: "1" } }),
        chatTurn("ok."),
      ],
      { printed },
    );
    await t.run();

    // The gate saw nothing: an MCP server must never answer a wallet action.
    assert.deepEqual(t.gateCalls, [], "send_mon must not be routed to the MCP gate");
    // Real boundary, real refusal (unknown recipient — refused before any prompt).
    const toolMsg = t.history.findLast((m) => m.role === "tool");
    assert.ok(toolMsg, "the tool result must be fed back into history");
    assert.match(toolMsg.content, /^Refused: unknown recipient/);
    // Refusal → scripted failure → the CLI exits 1 through this exact mapping.
    assert.equal(t.hadFailure.value, true, "a refused write must fail a scripted run");
    assert.equal(cli.propagateHadFailure(t.hadFailure, false), true);
  });

  test("a built-in read goes through dispatchToolCall, prints once, and never touches handleAction", async () => {
    const printed = [];
    const handled = [];
    const handleStub = async (action) => { handled.push(action); return "SHOULD NOT HAPPEN"; };
    const t = makeTurn(
      [nativeToolCallTurn({ id: "1", name: "get_address", arguments: {} }), chatTurn("ok.")],
      { handleAction: handleStub, printed },
    );
    await t.run();

    assert.deepEqual(handled, [], "a read must not go through handleAction");
    assert.deepEqual(t.gateCalls, [], "a read must not go through the MCP gate either");
    const toolMsg = t.history.findLast((m) => m.role === "tool");
    assert.ok(printed.some((p) => p.includes(toolMsg.content)), "the read result must be printed for the operator");
    assert.equal(t.hadFailure.value, false);
  });

  test("a read refusal still fails the scripted run", async () => {
    const printed = [];
    const t = makeTurn(
      [nativeToolCallTurn({ id: "1", name: "get_nfts", arguments: { address: "not-an-address" } }), chatTurn("ok.")],
      { printed },
    );
    await t.run();

    const toolMsg = t.history.findLast((m) => m.role === "tool");
    assert.match(toolMsg.content, /^Refused:/);
    assert.equal(t.hadFailure.value, true);
    assert.equal(cli.propagateHadFailure(t.hadFailure, false), true);
  });

  test("an MCP tool call goes to the gate and nowhere else", async () => {
    const printed = [];
    const handled = [];
    const handleStub = async (action) => { handled.push(action); return "SHOULD NOT HAPPEN"; };
    const dispatched = [];
    const dispatchStub = async (name, args) => { dispatched.push(name); return "SHOULD NOT HAPPEN"; };
    const t = makeTurn(
      [nativeToolCallTurn({ id: "1", name: "srv_do_thing", arguments: { x: 1 } }), chatTurn("ok.")],
      { handleAction: handleStub, dispatchToolCall: dispatchStub, printed },
    );
    await t.run();

    assert.equal(t.gateCalls.length, 1, "the server's tool must reach the confirmation gate");
    assert.equal(t.gateCalls[0].name, "srv_do_thing");
    assert.deepEqual(handled, []);
    assert.deepEqual(dispatched, []);
    assert.equal(t.history.findLast((m) => m.role === "tool").content, "mcp result");
  });

  test("the MCP confirmation gate refuses a call the operator never approved", async () => {
    let invoked = 0;
    const out = await cli.invokeMcpToolCall({
      name: "srv_do_thing",
      arguments: { x: 1 },
      invoke: async () => { invoked++; return "server result"; },
    });

    // Scripted mode has no answer line left: the gate cancels instead of running.
    assert.match(String(out), /^Refused: the operator declined this tool call\./);
    assert.equal(invoked, 0, "the server must not be called before the operator says yes");
  });
});

describe("MCP connected — scripted failure handling", () => {
  test("an SDK toolError is reported and fails the run", async () => {
    const printed = [];
    const t = makeTurn(
      [{
        events: [{ type: "toolError", error: { code: "VALIDATION_ERROR", message: "bad arguments" } }],
        final: { contentText: "sorry", toolCalls: [] },
      }],
      { printed },
    );
    await t.run();

    assert.ok(printed.some((p) => p.includes("tool error [VALIDATION_ERROR]: bad arguments")));
    assert.equal(t.hadFailure.value, true);
    assert.equal(cli.propagateHadFailure(t.hadFailure, false), true);
  });

  test("a hit round limit is reported and fails the run", async () => {
    const printed = [];
    // Same shape every round → completeWithMcp runs past maxToolRounds (8).
    const runaway = nativeToolCallTurn({ id: "x", name: "srv_forever", arguments: {} });
    const t = makeTurn([runaway], { printed });
    const result = await t.run();

    assert.equal(result.limitReached, true);
    assert.ok(printed.some((p) => p.includes("stopped after 8 tool-call rounds")));
    assert.equal(t.hadFailure.value, true);
  });
});

describe("dispatchNativeCall — the shared seam", () => {
  const routed = async (call) => {
    const seen = { handle: [], dispatch: [] };
    const out = await dispatchNativeCall(call, {
      handleAction: async (action) => { seen.handle.push(action); return "via handleAction"; },
      dispatchToolCall: async (name, args) => { seen.dispatch.push({ name, args }); return "via dispatch"; },
      isWrite,
    });
    return { seen, out };
  };

  test("writes route to handleAction with the action object the boundary expects", async () => {
    const { seen, out } = await routed({ name: "send_mon", arguments: { to: "0x1", amountMon: "1" } });
    assert.equal(out.boundary, "handleAction");
    assert.equal(out.result, "via handleAction");
    assert.deepEqual(seen.handle, [{ action: "send_mon", to: "0x1", amountMon: "1" }]);
    assert.deepEqual(seen.dispatch, []);
  });

  test("account WITH an index is a switch (handleAction); without one it is a read", async () => {
    const withIndex = await routed({ name: "account", arguments: { index: "1" } });
    assert.equal(withIndex.out.boundary, "handleAction");
    const list = await routed({ name: "account", arguments: {} });
    assert.equal(list.out.boundary, "dispatchToolCall");
    assert.deepEqual(list.seen.dispatch, [{ name: "account", args: {} }]);
  });

  test("reads route to dispatchToolCall with the raw arguments", async () => {
    const { seen, out } = await routed({ name: "get_nfts", arguments: { address: "0x1" } });
    assert.equal(out.boundary, "dispatchToolCall");
    assert.deepEqual(seen.dispatch, [{ name: "get_nfts", args: { address: "0x1" } }]);
    assert.deepEqual(seen.handle, []);
  });
});
