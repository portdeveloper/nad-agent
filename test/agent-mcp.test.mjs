/**
 * completeWithMcp() — the loop that wires MCP tool calls into a completion,
 * feeding results back for a follow-up turn. Driven end-to-end against a fake
 * `runCompletion` (the { events, final } shape completion() returns), so this
 * exercises the actual loop control flow, not just its call signature.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { completeWithMcp } from "../src/agent.mjs";

/** One fake completion() call: replays `events`, then resolves `final`. */
function fakeRun({ events = [], final }) {
  return {
    events: (async function* () {
      for (const e of events) yield e;
    })(),
    final: Promise.resolve(final),
  };
}

describe("completeWithMcp — no tool calls", () => {
  test("returns the model's text after a single round", async () => {
    let calls = 0;
    const runCompletion = () => {
      calls++;
      return fakeRun({
        events: [{ type: "contentDelta", text: "hi there" }],
        final: { contentText: "hi there", toolCalls: [] },
      });
    };
    const history = [{ role: "user", content: "hello" }];
    const result = await completeWithMcp(history, { mcpClients: [{ name: "s", client: {} }], runCompletion });

    assert.equal(calls, 1);
    assert.equal(result.text, "hi there");
    assert.equal(result.rounds, 0);
    assert.deepEqual(result.toolErrors, []);
    assert.equal(result.limitReached, false);
    // No tool calls: the loop leaves pushing the assistant turn to the caller.
    assert.equal(history.length, 1);
  });

  test("streams contentDelta text to onToken", async () => {
    const seen = [];
    const runCompletion = () =>
      fakeRun({
        events: [{ type: "contentDelta", text: "a" }, { type: "contentDelta", text: "b" }],
        final: { contentText: "ab", toolCalls: [] },
      });
    await completeWithMcp([], { mcpClients: [], runCompletion, onToken: (t) => seen.push(t) });
    assert.deepEqual(seen, ["a", "b"]);
  });
});

describe("completeWithMcp — tool-call loop", () => {
  test("feeds a tool result back and re-completes for a follow-up turn", async () => {
    let calls = 0;
    const seenHistories = [];
    const runCompletion = (params) => {
      calls++;
      seenHistories.push(JSON.parse(JSON.stringify(params.history)));
      if (calls === 1) {
        return fakeRun({
          events: [],
          final: {
            contentText: "let me check",
            toolCalls: [{ id: "1", name: "get_balance", arguments: {} }],
          },
        });
      }
      return fakeRun({ events: [], final: { contentText: "you have 5 MON", toolCalls: [] } });
    };

    const invoked = [];
    const invokeToolCall = async (call) => {
      invoked.push(call);
      return "5 MON";
    };

    const history = [{ role: "user", content: "what's my balance" }];
    const result = await completeWithMcp(history, {
      mcpClients: [{ name: "s", client: {} }],
      runCompletion,
      invokeToolCall,
    });

    assert.equal(calls, 2, "the model must be re-completed after the tool result");
    assert.equal(result.text, "you have 5 MON");
    assert.equal(result.rounds, 1);
    assert.equal(invoked.length, 1);
    assert.equal(invoked[0].name, "get_balance");

    // The second completion() call must have seen the tool result in history.
    const secondCallHistory = seenHistories[1];
    assert.deepEqual(secondCallHistory.at(-2), { role: "assistant", content: "let me check" });
    assert.deepEqual(secondCallHistory.at(-1), { role: "tool", content: "5 MON" });

    // The intermediate round pushed its own assistant+tool turn; the final
    // round's assistant text ("you have 5 MON") is left for the caller to push.
    assert.equal(history.length, 3);
  });

  test("invokes every tool call in a multi-call round, in order", async () => {
    let calls = 0;
    const runCompletion = () => {
      calls++;
      if (calls === 1) {
        return fakeRun({
          events: [],
          final: {
            contentText: "",
            toolCalls: [
              { id: "1", name: "get_balance", arguments: {} },
              { id: "2", name: "get_address", arguments: {} },
            ],
          },
        });
      }
      return fakeRun({ events: [], final: { contentText: "done", toolCalls: [] } });
    };
    const order = [];
    const invokeToolCall = async (call) => {
      order.push(call.name);
      return `result:${call.name}`;
    };
    const history = [];
    await completeWithMcp(history, { mcpClients: [{ name: "s", client: {} }], runCompletion, invokeToolCall });

    assert.deepEqual(order, ["get_balance", "get_address"]);
    assert.deepEqual(history.at(-2), { role: "tool", content: "result:get_balance" });
    assert.deepEqual(history.at(-1), { role: "tool", content: "result:get_address" });
  });

  test("throws if the model calls a tool but no invokeToolCall was given", async () => {
    const runCompletion = () =>
      fakeRun({ events: [], final: { contentText: "", toolCalls: [{ id: "1", name: "x", arguments: {} }] } });
    await assert.rejects(
      () => completeWithMcp([], { mcpClients: [{ name: "s", client: {} }], runCompletion }),
      /invokeToolCall is required/,
    );
  });
});

describe("completeWithMcp — tool errors", () => {
  test("surfaces a toolError event instead of swallowing it", async () => {
    const runCompletion = () =>
      fakeRun({
        events: [{ type: "toolError", error: { code: "UNKNOWN_TOOL", message: "no such tool" } }],
        final: { contentText: "sorry, I can't do that", toolCalls: [] },
      });
    const result = await completeWithMcp([], { mcpClients: [{ name: "s", client: {} }], runCompletion });
    assert.equal(result.toolErrors.length, 1);
    assert.equal(result.toolErrors[0].code, "UNKNOWN_TOOL");
    assert.equal(result.text, "sorry, I can't do that");
  });
});

describe("completeWithMcp — round limit", () => {
  test("stops after maxToolRounds and reports limitReached", async () => {
    let calls = 0;
    const runCompletion = () => {
      calls++;
      return fakeRun({
        events: [],
        final: { contentText: "again", toolCalls: [{ id: String(calls), name: "loop", arguments: {} }] },
      });
    };
    const result = await completeWithMcp([], {
      mcpClients: [{ name: "s", client: {} }],
      runCompletion,
      invokeToolCall: async () => "ok",
      maxToolRounds: 2,
    });
    assert.equal(result.limitReached, true);
    assert.equal(result.rounds, 2);
    assert.equal(calls, 3, "2 rounds of tool calls, then one more completion that trips the limit");
  });
});

describe("completeWithMcp — model stream error", () => {
  test("does not throw when the event stream errors, and stops the loop", async () => {
    const runCompletion = () => ({
      events: (async function* () {
        throw new Error("CONTEXT_OVERFLOW");
      })(),
      // Never awaited once events throw — resolved (not rejected) so an
      // unrelated unhandledRejection can't mask what this test checks.
      final: Promise.resolve({ contentText: "", toolCalls: [] }),
    });
    const seen = [];
    const result = await completeWithMcp([], {
      mcpClients: [{ name: "s", client: {} }],
      runCompletion,
      onToken: (t) => seen.push(t),
    });
    assert.equal(result.limitReached, false);
    assert.ok(seen.some((t) => t.includes("model stopped")));
  });
});
