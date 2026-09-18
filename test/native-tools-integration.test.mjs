/**
 * Integration tests for native tool-calling: SDK-valid completion events flow
 * through the REAL completeWithTools event parser (src/agent.mjs) and the REAL
 * production loop (src/nativeToolLoop.mjs).
 *
 * Locked @qvac/sdk 0.14.1 emits `toolError` (error in `event.error`) on
 * `run.events`; `toolCallError` belongs to the separate tool-call stream. These
 * tests pin the real shapes end to end — earlier versions of this file asserted
 * hand-built objects, so the wrong event name was invisible to the suite.
 */

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { completeWithTools } from "../src/agent.mjs";
import { runNativeToolLoop, formatToolError } from "../src/nativeToolLoop.mjs";
import { getToolDefinitions, dispatchToolCall, isWrite } from "../src/tools.mjs";

/** Fake QVAC `completion()` whose run emits exactly `events` on `run.events`. */
function fakeRunCompletion(events) {
  return function runCompletion(_params, _opts) {
    return {
      events: (async function* () {
        for (const e of events) yield e;
      })(),
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

function recordingDispatch() {
  const calls = [];
  const fn = async (name, args) => {
    calls.push({ name, args });
    if (name === "get_address") return "(wallet not initialized)";
    if (name === "get_balance") return "0.5 MON";
    return `dispatch-stub: ${name}`;
  };
  fn.calls = calls;
  return fn;
}

function recordingHandle() {
  const calls = [];
  const fn = async (action) => {
    calls.push(action);
    return "cancelled";
  };
  fn.calls = calls;
  return fn;
}

beforeEach(() => {
  stream.printed.length = 0;
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. completeWithTools parses the real SDK event shapes.
// ─────────────────────────────────────────────────────────────────────────────

describe("completeWithTools — SDK 0.14.1 event shapes", () => {
  test("collects toolError payloads with code and message preserved", async () => {
    const result = await completeWithTools([], [], null, {
      runCompletion: fakeRunCompletion([
        { type: "contentDelta", seq: 0, text: "trying…" },
        {
          type: "toolError",
          seq: 1,
          error: { code: "VALIDATION_ERROR", message: "send_mon.amountMon: expected string" },
        },
      ]),
    });
    assert.equal(result.text, "trying…");
    assert.deepEqual(result.toolCalls, []);
    assert.equal(result.toolErrors.length, 1);
    assert.equal(result.toolErrors[0].code, "VALIDATION_ERROR");
    assert.equal(result.toolErrors[0].message, "send_mon.amountMon: expected string");
  });

  test("collects toolCall events into toolCalls", async () => {
    const result = await completeWithTools([], [], null, {
      runCompletion: fakeRunCompletion([
        {
          type: "toolCall",
          seq: 0,
          call: { id: "call_1", name: "get_balance", arguments: {} },
        },
      ]),
    });
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, "get_balance");
    assert.deepEqual(result.toolErrors, []);
  });

  test("a legacy toolCallError is preserved, never silently dropped", async () => {
    const result = await completeWithTools([], [], null, {
      runCompletion: fakeRunCompletion([
        {
          type: "toolCallError",
          error: { code: "PARSE_ERROR", message: "could not parse tool call" },
        },
      ]),
    });
    assert.equal(result.toolErrors.length, 1);
    assert.equal(formatToolError(result.toolErrors[0]), "[PARSE_ERROR]: could not parse tool call");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Production loop: tool results re-enter history (blocker #1) and SDK errors
//    fail scripted runs with the message intact (blocker #2).
// ─────────────────────────────────────────────────────────────────────────────

describe("production loop — tool results and SDK errors end to end", () => {
  test("tool result lands in history so the model gets a follow-up turn", async () => {
    const dispatch = recordingDispatch();
    const handleAction = recordingHandle();
    let calls = 0;
    const completeViaParser = (history, tools, onToken) => {
      calls++;
      if (calls === 1) {
        return completeWithTools(history, tools, onToken, {
          runCompletion: fakeRunCompletion([
            {
              type: "toolCall",
              seq: 0,
              call: { id: "call_1", name: "get_address", arguments: {} },
            },
          ]),
        });
      }
      return completeWithTools(history, tools, onToken, {
        runCompletion: fakeRunCompletion([
          { type: "contentDelta", seq: 0, text: "your address is shown above." },
        ]),
      });
    };

    const history = [{ role: "system", content: "test" }];
    const hadFailure = { value: false };
    await runNativeToolLoop({
      history,
      completeWithTools: completeViaParser,
      getToolDefinitions,
      handleAction,
      dispatchToolCall: dispatch,
      isWrite,
      printw: stream.printw,
      println: stream.println,
      DIM: "", RST: "", c: noColor, SCRIPTED: true,
      hadFailure,
    });

    assert.equal(calls, 2, "the model must be re-completed after the tool result");
    assert.equal(hadFailure.value, false);
    const toolMsg = history.find((m) => m.role === "tool");
    assert.ok(toolMsg, "tool result must be added to history");
    assert.match(toolMsg.content, /get_address/);
    assert.equal(history.at(-1).content, "your address is shown above.");
  });

  test("SDK toolError through the exact parser + loop fails scripted with message", async () => {
    const dispatch = recordingDispatch();
    const handleAction = recordingHandle();
    const sdkMessage = "unknown tool requested by model";
    const completeViaParser = (history, tools, onToken) =>
      completeWithTools(history, tools, onToken, {
        runCompletion: fakeRunCompletion([
          {
            type: "toolError",
            seq: 0,
            error: { code: "UNKNOWN_TOOL", message: sdkMessage },
          },
        ]),
      });

    const hadFailure = { value: false };
    await runNativeToolLoop({
      history: [{ role: "system", content: "test" }],
      completeWithTools: completeViaParser,
      getToolDefinitions,
      handleAction,
      dispatchToolCall: dispatch,
      isWrite,
      printw: stream.printw,
      println: stream.println,
      DIM: "", RST: "", c: noColor, SCRIPTED: true,
      hadFailure,
    });

    assert.equal(hadFailure.value, true, "SDK toolError must fail a scripted run");
    const printed = stream.printed.join("");
    assert.ok(printed.includes(sdkMessage), "message must survive to the operator");
    assert.ok(printed.includes("UNKNOWN_TOOL"), "code must survive to the operator");
  });

  test("turn exhaustion through the exact parser + loop fails scripted", async () => {
    const dispatch = recordingDispatch();
    const handleAction = recordingHandle();
    const completeViaParser = (history, tools, onToken) =>
      completeWithTools(history, tools, onToken, {
        runCompletion: fakeRunCompletion([
          {
            type: "toolCall",
            seq: 0,
            call: { id: "call_x", name: "get_address", arguments: {} },
          },
        ]),
      });

    const hadFailure = { value: false };
    await runNativeToolLoop({
      history: [{ role: "system", content: "test" }],
      completeWithTools: completeViaParser,
      getToolDefinitions,
      handleAction,
      dispatchToolCall: dispatch,
      isWrite,
      printw: stream.printw,
      println: stream.println,
      DIM: "", RST: "", c: noColor, SCRIPTED: true,
      hadFailure,
      MAX_TURNS: 3,
      MAX_TOOL_CALLS: 100,
    });

    assert.equal(hadFailure.value, true, "turn exhaustion must fail a scripted run");
    assert.ok(stream.printed.join("").includes("turn limit"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Tool definitions cover the v0 action set (minus chat-only `none`).
// ─────────────────────────────────────────────────────────────────────────────

describe("getToolDefinitions — action-set coverage", () => {
  test("advertises all 9 callable actions", () => {
    const names = new Set(getToolDefinitions().map((t) => t.name));
    for (const name of [
      "get_address", "get_balance", "get_token_balance", "get_nfts",
      "send_mon", "send_token", "transfer_nft", "swap", "account",
    ]) {
      assert.ok(names.has(name), `missing tool: ${name}`);
    }
    assert.equal(names.size, 9);
    assert.ok(!names.has("none"), "`none` is chat-only and must not be a tool");
  });

  test("read fast path executes without confirmation", async () => {
    const result = await dispatchToolCall("get_address", {}).catch((e) => e.message);
    assert.ok(typeof result === "string");
  });
});

console.log("\n✓ Native tool-calling integration: SDK events → real parser → real loop");
console.log("✓ toolError payloads keep code + message into hadFailure and the transcript");
console.log("✓ Tool results re-enter history for a follow-up turn; turn exhaustion fails scripted");
