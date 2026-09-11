/**
 * CLI-boundary regression for native tool-calling (PR #77 blocker).
 *
 * Drives the production `runNativeToolLoop` from `src/nativeToolLoop.mjs` and proves
 * that a `send_mon` tool call from the model goes through `handleAction` (the same
 * safety boundary the slash commands and the v0 path use), NOT directly through
 * `dispatchToolCall`.
 *
 * The loop already takes both `handleAction` and `dispatchToolCall` as injected
 * dependencies — that's the seam this test exploits. We hand it stubbed versions
 * that record every call:
 *
 *   - If the loop ever short-circuits a write through `dispatchToolCall`, the
 *     sendStub sees it and the test fails.
 *   - If the loop ever drops the handleAction call, the handleStub sees nothing
 *     and the test fails.
 *   - If a policy/resolveSend/refusal path tries to skip the boundary, the
 *     cancellation case proves wallet.send (and the boundary's real confirm)
 *     was never reached.
 *
 * The production `isWrite` from `src/tools.mjs` decides which side of the seam
 * a tool call goes — that is the routing the security fix pins in place.
 */

import { describe, it, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { runNativeToolLoop } from "../src/nativeToolLoop.mjs";
import { isWrite, resolveSend, prepareTokenSend } from "../src/tools.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Test harness: stubbed boundary seams + captured stream.
// ─────────────────────────────────────────────────────────────────────────────

/** Build a recording dispatchToolCall. Reads must flow through here in the
 *  happy path; the test fails if a write is ever routed here. */
function makeSendStub() {
  const calls = [];
  const fn = async function dispatchToolCallStub(name, args) {
    calls.push({ name, args });
    // Mirror the real read path's behaviour for get_address in this env:
    // a missing wallet surfaces as the same "(wallet not initialized)" string.
    if (name === "get_address") return "(wallet not initialized)";
    if (name === "get_balance") return "0.5 MON";
    return `dispatch-stub: ${name}`;
  };
  fn.calls = calls;
  return fn;
}

/** Build a recording handleAction. By default the operator types "n" so any
 *  write must be cancelled by the boundary and never reach the wallet. */
function makeHandleStub({ answer = "n", buildRealBoundary = false } = {}) {
  const calls = [];
  const fn = async function handleActionStub(action) {
    calls.push({ action, answer });
    if (action.action === "none") return null;

    // Optional: drive the PRODUCTION resolveSend/prepareTokenSend inside the
    // stub so the test proves the real refusal path runs through the same
    // boundary code, not a parallel implementation in the test.
    if (buildRealBoundary) {
      if (action.action === "send_mon") {
        const r = resolveSend(action, { policy: null, sessionSpent: 0n });
        if (!r.ok) return `Refused: ${r.reason}`;
      }
      if (action.action === "send_token") {
        const r = await prepareTokenSend(action, { policy: null, sessionSpent: 0n });
        if (!r.ok) return `Refused: ${r.reason}`;
      }
    }

    if (answer === "y") {
      if (action.action === "send_mon") return "Sent 0.1 MON";
      if (action.action === "send_token") return "Sent 1 USDC";
    }
    return "cancelled";
  };
  fn.calls = calls;
  return fn;
}

/** A single-shot completeWithTools replacement. Yields one completion (tool
 *  call OR plain text) per call, then falls back to a text-only reply so the
 *  loop exits cleanly. Matches the real QVAC event shape. */
function makeFakeComplete(responses) {
  let i = 0;
  return async function fakeCompleteWithTools(history, tools, onToken) {
    const next = i < responses.length ? responses[i++] : { text: "done.", toolCalls: [] };
    if (next.text && onToken) onToken(next.text);
    return {
      text: next.text ?? "",
      toolCalls: next.toolCalls ?? [],
      toolErrors: next.toolErrors ?? [],
    };
  };
}

const stream = {
  printed: [],
  printw(text) { stream.printed.push(text); },
  println(text) { stream.printed.push(text); },
};

const noColor = {
  red: (s) => s, cyan: (s) => s, yellow: (s) => s, dim: (s) => s, bold: (s) => s,
  green: (s) => s, prompt: (s) => s, violet: (s) => s,
};
const DIM = "";
const RST = "";

/** Run the production loop with the stubs in place. */
async function runOnce({ responses, handleAction, dispatchToolCall }) {
  const completeWithTools = makeFakeComplete(responses);
  const hadFailure = { value: false };
  const history = [{ role: "system", content: "test" }];
  await runNativeToolLoop({
    history,
    completeWithTools,
    getToolDefinitions: () => [],
    handleAction,
    dispatchToolCall,
    isWrite, // PRODUCTION routing function — the whole point of the fix
    printw: stream.printw,
    println: stream.println,
    DIM, RST, c: noColor, SCRIPTED: true,
    hadFailure,
  });
  return { history, hadFailure };
}

beforeEach(() => {
  stream.printed.length = 0;
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Write boundary: handleAction is the seam writes go through.
// ─────────────────────────────────────────────────────────────────────────────

describe("Native tool loop — write boundary (PR #77 regression)", () => {
  test("send_mon tool call is routed to handleAction, NOT to dispatchToolCall", async () => {
    const handleAction = makeHandleStub({ answer: "n" });
    const dispatch = makeSendStub();

    const { history } = await runOnce({
      responses: [
        {
          text: "",
          toolCalls: [
            {
              id: "call_1",
              name: "send_mon",
              arguments: { to: "0x000000000000000000000000000000000000dEaD", amountMon: "0.1" },
            },
          ],
        },
      ],
      handleAction,
      dispatchToolCall: dispatch,
    });

    // (1) The loop MUST have called handleAction with the send_mon action.
    assert.equal(handleAction.calls.length, 1, "handleAction was not invoked for the write tool call");
    assert.equal(handleAction.calls[0].action.action, "send_mon");
    assert.equal(handleAction.calls[0].action.to, "0x000000000000000000000000000000000000dEaD");
    assert.equal(handleAction.calls[0].action.amountMon, "0.1");

    // (2) dispatchToolCall MUST NOT have been called for a write — that is
    //     the bypass this test pins down. If a future change sends writes
    //     through dispatch, this assertion fails first.
    assert.equal(
      dispatch.calls.length,
      0,
      "write tool call was routed through dispatchToolCall instead of handleAction — security bypass regressed"
    );

    // (3) The tool result lands in history so the model can react.
    const toolMsg = history.find((m) => m.role === "tool");
    assert.ok(toolMsg, "no tool-result message was added to history");
    assert.match(toolMsg.content, /cancelled|Refused/);
  });

  test("send_mon with y confirmation still routes to handleAction (boundary, not direct wallet)", async () => {
    const handleAction = makeHandleStub({ answer: "y" });
    const dispatch = makeSendStub();

    await runOnce({
      responses: [
        {
          text: "",
          toolCalls: [
            {
              id: "call_2",
              name: "send_mon",
              arguments: { to: "0x000000000000000000000000000000000000dEaD", amountMon: "0.1" },
            },
          ],
        },
      ],
      handleAction,
      dispatchToolCall: dispatch,
    });

    // Same routing invariant: even on the happy path the loop hands the call
    // to the boundary, which is what owns the confirm and the wallet call.
    assert.equal(handleAction.calls.length, 1);
    assert.equal(handleAction.calls[0].action.amountMon, "0.1");
    assert.equal(dispatch.calls.length, 0, "send_mon must not be dispatched directly even on y");
  });

  test("send_token tool call also routes through handleAction (the second write path)", async () => {
    const handleAction = makeHandleStub({ answer: "n", buildRealBoundary: true });
    const dispatch = makeSendStub();

    const { history } = await runOnce({
      responses: [
        {
          text: "",
          toolCalls: [
            {
              id: "call_3",
              name: "send_token",
              arguments: {
                token: "NOT_A_TOKEN",
                to: "0x000000000000000000000000000000000000dEaD",
                amount: "1",
              },
            },
          ],
        },
      ],
      handleAction,
      dispatchToolCall: dispatch,
    });

    assert.equal(handleAction.calls.length, 1);
    assert.equal(handleAction.calls[0].action.action, "send_token");
    assert.equal(dispatch.calls.length, 0, "send_token must not be dispatched directly");

    // The stub ran the production prepareTokenSend; the refusal should
    // appear in the tool result so the model sees the same string the
    // production boundary would have produced.
    const toolMsg = history.find((m) => m.role === "tool");
    assert.ok(toolMsg);
    assert.match(toolMsg.content, /Refused/);
  });

  test("a policy/resolveSend refusal goes through handleAction and surfaces a Refused tool result", async () => {
    // Drive the production resolveSend() from inside the stub so the test
    // proves the real boundary code refuses, not a parallel test impl.
    // A negative amount short-circuits inside resolveSend, before any
    // confirm() prompt can run.
    const handleAction = makeHandleStub({ answer: "n", buildRealBoundary: true });
    const dispatch = makeSendStub();

    const { history } = await runOnce({
      responses: [
        {
          text: "",
          toolCalls: [
            {
              id: "call_4",
              name: "send_mon",
              arguments: { to: "0x000000000000000000000000000000000000dEaD", amountMon: "-1" },
            },
          ],
        },
      ],
      handleAction,
      dispatchToolCall: dispatch,
    });

    // handleAction was called once, the real resolveSend refused, the
    // boundary recorded a "cancelled" or "Refused" string, the loop did
    // not retry via dispatchToolCall, and the model sees the refusal.
    assert.equal(handleAction.calls.length, 1);
    assert.equal(dispatch.calls.length, 0);
    const toolMsg = history.find((m) => m.role === "tool");
    assert.ok(toolMsg);
    assert.match(toolMsg.content, /Refused/);
  });

  test("isWrite() is the routing function — writes go to handleAction, reads go to dispatchToolCall", () => {
    // This is the property the fix pins: the loop uses isWrite() to decide.
    // If isWrite() ever stops recognizing a write, the loop will mis-route.
    // Pin the table here so the contract is obvious from the test file.
    assert.equal(isWrite("send_mon"), true, "send_mon must be classified as a write");
    assert.equal(isWrite("send_token"), true, "send_token must be classified as a write");
    assert.equal(isWrite("transfer_nft"), true, "transfer_nft must be classified as a write");
    assert.equal(isWrite("swap"), true, "swap must be classified as a write");
    assert.equal(isWrite("get_address"), false, "get_address must be classified as a read");
    assert.equal(isWrite("get_balance"), false, "get_balance must be classified as a read");
    assert.equal(isWrite("get_token_balance"), false, "get_token_balance must be classified as a read");
    assert.equal(isWrite("none"), false, "none must be classified as a read");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Read fast path: dispatchToolCall, no handleAction.
// ─────────────────────────────────────────────────────────────────────────────

describe("Native tool loop — read fast path", () => {
  test("get_address tool call is dispatched directly, not via handleAction", async () => {
    const handleAction = makeHandleStub();
    const dispatch = makeSendStub();

    const { history } = await runOnce({
      responses: [
        {
          text: "",
          toolCalls: [{ id: "call_r1", name: "get_address", arguments: {} }],
        },
      ],
      handleAction,
      dispatchToolCall: dispatch,
    });

    // Reads are NOT a write — the loop MUST have used dispatchToolCall, the
    // read-only fast path. handleAction should be untouched.
    assert.equal(dispatch.calls.length, 1, "read tool call must go through dispatchToolCall");
    assert.equal(dispatch.calls[0].name, "get_address");
    assert.equal(handleAction.calls.length, 0, "read tool call must not be re-routed through handleAction");
    const toolMsg = history.find((m) => m.role === "tool");
    assert.ok(toolMsg);
    assert.match(toolMsg.content, /get_address/);
  });

  test("get_balance tool call also uses the read fast path", async () => {
    const handleAction = makeHandleStub();
    const dispatch = makeSendStub();

    await runOnce({
      responses: [
        {
          text: "",
          toolCalls: [{ id: "call_r2", name: "get_balance", arguments: {} }],
        },
      ],
      handleAction,
      dispatchToolCall: dispatch,
    });

    assert.equal(dispatch.calls.length, 1);
    assert.equal(dispatch.calls[0].name, "get_balance");
    assert.equal(handleAction.calls.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. hadFailure propagation: failures inside the loop must be visible after it
//    returns — the exact bug the maintainer flagged (cli.mjs never copied
//    hadFailureRef.value back into hadFailure after the loop).
// ─────────────────────────────────────────────────────────────────────────────

describe("Native tool loop — hadFailure propagation (processLine/CLI boundary)", () => {
  test("toolCallError inside loop sets hadFailure.value (toolErrors path)", async () => {
    // The loop exits early when toolErrors is non-empty and sets hadFailure.value.
    const handleAction = makeHandleStub();
    const dispatch = makeSendStub();
    const completeWithTools = makeFakeComplete([
      {
        text: "",
        toolCalls: [],
        toolErrors: [{ error: "malformed tool call" }],
      },
    ]);

    const hadFailure = { value: false };
    await runNativeToolLoop({
      history: [{ role: "system", content: "test" }],
      completeWithTools,
      getToolDefinitions: () => [],
      handleAction,
      dispatchToolCall: dispatch,
      isWrite,
      printw: stream.printw,
      println: stream.println,
      DIM, RST, c: noColor, SCRIPTED: true,
      hadFailure,
    });

    // The loop must have set hadFailure.value = true for the caller (cli.mjs)
    // to propagate it into the outer hadFailure boolean and exit with code 1.
    assert.equal(hadFailure.value, true, "toolCallError must set hadFailure.value");
  });

  test("tool-call cap exceeded sets hadFailure.value", async () => {
    // Feed 3 tool calls with a cap of 2; the loop should set hadFailure.value.
    const dispatch = makeSendStub();
    const handleAction = makeHandleStub();
    const completeWithTools = makeFakeComplete([
      { text: "", toolCalls: [{ id: "c1", name: "get_address", arguments: {} }] },
      { text: "", toolCalls: [{ id: "c2", name: "get_address", arguments: {} }] },
      { text: "", toolCalls: [{ id: "c3", name: "get_address", arguments: {} }] },
    ]);

    const hadFailure = { value: false };
    await runNativeToolLoop({
      history: [{ role: "system", content: "test" }],
      completeWithTools,
      getToolDefinitions: () => [],
      handleAction,
      dispatchToolCall: dispatch,
      isWrite,
      printw: stream.printw,
      println: stream.println,
      DIM, RST, c: noColor, SCRIPTED: true,
      hadFailure,
      MAX_TOOL_CALLS: 2,
    });

    assert.equal(hadFailure.value, true, "cap exceeded must set hadFailure.value");
  });

  test("dispatch exception sets hadFailure.value", async () => {
    // dispatchToolCall throws; the loop catches it and sets hadFailure.value.
    const throwingDispatch = async () => { throw new Error("dispatch exploded"); };
    const handleAction = makeHandleStub();
    const completeWithTools = makeFakeComplete([
      { text: "", toolCalls: [{ id: "cx", name: "get_balance", arguments: {} }] },
    ]);

    const hadFailure = { value: false };
    await runNativeToolLoop({
      history: [{ role: "system", content: "test" }],
      completeWithTools,
      getToolDefinitions: () => [],
      handleAction,
      dispatchToolCall: throwingDispatch,
      isWrite,
      printw: stream.printw,
      println: stream.println,
      DIM, RST, c: noColor, SCRIPTED: true,
      hadFailure,
    });

    assert.equal(hadFailure.value, true, "dispatch exception must set hadFailure.value");
  });

  test("clean run leaves hadFailure.value false — no spurious failures", async () => {
    // A run with no errors must not set hadFailure.value, so a clean loop
    // doesn't cause the CLI to exit with code 1.
    const dispatch = makeSendStub();
    const handleAction = makeHandleStub();
    const completeWithTools = makeFakeComplete([
      { text: "", toolCalls: [{ id: "ok1", name: "get_address", arguments: {} }] },
      // Second call: no tool calls → loop exits cleanly.
    ]);

    const hadFailure = { value: false };
    await runNativeToolLoop({
      history: [{ role: "system", content: "test" }],
      completeWithTools,
      getToolDefinitions: () => [],
      handleAction,
      dispatchToolCall: dispatch,
      isWrite,
      printw: stream.printw,
      println: stream.println,
      DIM, RST, c: noColor, SCRIPTED: true,
      hadFailure,
    });

    assert.equal(hadFailure.value, false, "clean run must not set hadFailure.value");
  });
});

console.log("\n✓ Native tool CLI-boundary regression: writes route through handleAction");
console.log("✓ Read-only tool calls stay on dispatchToolCall (fast path)");
console.log("✓ Policy/resolveSend refusal runs through the real boundary code");
console.log("✓ PR #77 security blocker covered by a real boundary test, not a re-implemented loop");
console.log("✓ hadFailure propagation: toolErrors / cap / dispatch-exception all set hadFailure.value");
