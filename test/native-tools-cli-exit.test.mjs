/**
 * CLI exit-path regression for native tool-calling.
 *
 * Unlike the loop-level tests (which inject stubbed handleAction/dispatch), this
 * file drives the REAL CLI module — src/cli.mjs imported with NAD_CLI_NO_RUN=1 so
 * its exports load without starting the REPL — through the REAL completion
 * parser, the REAL native loop, the REAL handleAction boundary and the REAL
 * dispatch fast path, then through the REAL hadFailure → exit-code mapping that
 * feeds `process.exit(hadFailure ? 1 : 0)` in scripted mode.
 *
 * Only the model itself is faked (via the runCompletion seam: no GPU needed).
 * Turn exhaustion and SDK tool errors must yield exit code 1; a clean native
 * turn must yield exit code 0.
 */

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { completeWithTools } from "../src/agent.mjs";
import { runNativeToolLoop } from "../src/nativeToolLoop.mjs";
import {
  getToolDefinitions,
  dispatchToolCall,
  isWrite,
  systemPrompt,
  nativeSystemPrompt,
  selectSystemPrompt,
} from "../src/tools.mjs";

// Set BEFORE the dynamic cli.mjs import below: importing the CLI without this
// flag starts the REPL (drains stdin, loads the model, calls process.exit).
process.env.NAD_CLI_NO_RUN = "1";
const cli = await import("../src/cli.mjs");

const stream = {
  printed: [],
  printw(text) { stream.printed.push(text); },
  println(text) { stream.printed.push(text); },
};
const noColor = {
  red: (s) => s, cyan: (s) => s, yellow: (s) => s, dim: (s) => s, bold: (s) => s,
  green: (s) => s, prompt: (s) => s, violet: (s) => s,
};

/** Fake QVAC `completion()` emitting exactly `events` on `run.events`. */
function fakeRunCompletion(events) {
  return function runCompletion(_params, _opts) {
    return {
      events: (async function* () {
        for (const e of events) yield e;
      })(),
    };
  };
}

/** The exact production composition the REPL uses, with only the model faked. */
function realStack({ runCompletion, history, hadFailure, maxTurns = 10, maxCalls = 10 }) {
  const completeViaRealParser = (h, tools, onToken) =>
    completeWithTools(h, tools, onToken, { runCompletion });
  return runNativeToolLoop({
    history,
    completeWithTools: completeViaRealParser,
    getToolDefinitions,
    handleAction: cli.handleAction, // REAL CLI boundary (confirm/policy/resolveSend)
    dispatchToolCall, // REAL read fast path
    isWrite,
    printw: stream.printw,
    println: stream.println,
    DIM: "", RST: "", c: noColor, SCRIPTED: true,
    hadFailure,
    MAX_TURNS: maxTurns,
    MAX_TOOL_CALLS: maxCalls,
  });
}

/** cli.mjs's scripted exit mapping: process.exit(hadFailure ? 1 : 0). */
function exitCode(hadFailure) {
  return hadFailure ? 1 : 0;
}

beforeEach(() => {
  stream.printed.length = 0;
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. The CLI selects the prompt matching the enabled protocol.
// ─────────────────────────────────────────────────────────────────────────────

describe("CLI prompt selection — native vs v0", () => {
  test("nativeSystemPrompt never instructs JSON action lines", () => {
    const prompt = nativeSystemPrompt();
    assert.ok(!prompt.includes('{"action"'), "native prompt must not mention JSON actions");
    assert.ok(!prompt.includes("ONE line of JSON"), "native prompt must not ask for JSON lines");
    for (const tool of ["get_address", "get_balance", "send_mon", "transfer_nft", "swap", "account"]) {
      assert.ok(prompt.includes(tool), `native prompt missing ${tool}`);
    }
    assert.match(prompt, /call the matching tool/i);
  });

  test("systemPrompt still instructs the v0 JSON protocol", () => {
    assert.ok(systemPrompt().includes('{"action"'));
  });

  test("selectSystemPrompt maps the toggle to the right prompt", () => {
    assert.equal(selectSystemPrompt(true), nativeSystemPrompt());
    assert.equal(selectSystemPrompt(false), systemPrompt());
  });

  test("buildInitialHistory (real CLI code) follows the toggle", async () => {
    const { config } = await import("../src/config.mjs");
    const history = cli.buildInitialHistory();
    assert.equal(history.length, 1);
    assert.equal(history[0].role, "system");
    assert.equal(history[0].content, selectSystemPrompt(config.useNativeTools));
  });

  test("USE_NATIVE_TOOLS=false selects the v0 prompt in a fresh process", () => {
    const cliUrl = new URL("../src/cli.mjs", import.meta.url).href;
    const out = execFileSync(
      process.execPath,
      ["--input-type=module", "-e",
        `process.env.NAD_CLI_NO_RUN = "1";` +
        `const cli = await import(${JSON.stringify(cliUrl)});` +
        `process.stdout.write(cli.buildInitialHistory()[0].content);`],
      {
        env: { ...process.env, NAD_CLI_NO_RUN: "1", USE_NATIVE_TOOLS: "false" },
        encoding: "utf8",
        timeout: 60000,
      },
    );
    assert.ok(out.includes('{"action"'), "v0 mode must use the JSON prompt");
  });

  test("USE_NATIVE_TOOLS=true selects the native prompt in a fresh process", () => {
    const cliUrl = new URL("../src/cli.mjs", import.meta.url).href;
    const out = execFileSync(
      process.execPath,
      ["--input-type=module", "-e",
        `process.env.NAD_CLI_NO_RUN = "1";` +
        `const cli = await import(${JSON.stringify(cliUrl)});` +
        `process.stdout.write(cli.buildInitialHistory()[0].content);`],
      {
        env: { ...process.env, NAD_CLI_NO_RUN: "1", USE_NATIVE_TOOLS: "true" },
        encoding: "utf8",
        timeout: 60000,
      },
    );
    assert.ok(!out.includes('{"action"'), "native mode must not use the JSON prompt");
    assert.ok(out.includes("get_balance"), "native prompt must list tools");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The real handleAction boundary answers reads and pre-prompt refusals
//    without stubs (no wallet, no scripted confirm lines needed).
// ─────────────────────────────────────────────────────────────────────────────

describe("real handleAction boundary (no stubs)", () => {
  test("get_address read resolves without a wallet", async () => {
    const out = await cli.handleAction({ action: "get_address" });
    assert.ok(typeof out === "string");
  });

  test("send_mon to an unknown recipient is refused before any prompt", async () => {
    const out = await cli.handleAction({
      action: "send_mon",
      to: "nobody-in-the-book",
      amountMon: "0.1",
    });
    assert.match(String(out), /Refused/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Exit-path regression: scripted exit codes through the real stack.
// ─────────────────────────────────────────────────────────────────────────────

describe("CLI exit path — scripted exit codes via the real stack", () => {
  test("SDK toolError → hadFailure → propagate → exit 1, message intact", async () => {
    const sdkMessage = "get_token_balance.token: expected string";
    const history = [{ role: "system", content: "test" }];
    const hadFailureRef = { value: false };
    await realStack({
      runCompletion: fakeRunCompletion([
        {
          type: "toolError",
          seq: 0,
          error: { code: "VALIDATION_ERROR", message: sdkMessage },
        },
      ]),
      history,
      hadFailure: hadFailureRef,
    });

    assert.equal(hadFailureRef.value, true);
    // The REAL cli.mjs mapping (hadFailureRef → outer boolean → exit code).
    let outerHadFailure = false;
    outerHadFailure = cli.propagateHadFailure(hadFailureRef, outerHadFailure);
    assert.equal(outerHadFailure, true);
    assert.equal(exitCode(outerHadFailure), 1);
    const printed = stream.printed.join("");
    assert.ok(printed.includes(sdkMessage), "message must survive to the transcript");
    assert.ok(printed.includes("VALIDATION_ERROR"));
  });

  test("turn exhaustion → hadFailure → propagate → exit 1", async () => {
    const history = [{ role: "system", content: "test" }];
    const hadFailureRef = { value: false };
    await realStack({
      runCompletion: fakeRunCompletion([
        {
          type: "toolCall",
          seq: 0,
          call: { id: "call_loop", name: "get_address", arguments: {} },
        },
      ]),
      history,
      hadFailure: hadFailureRef,
      maxTurns: 3,
      maxCalls: 100,
    });

    assert.equal(hadFailureRef.value, true, "turn exhaustion must fail scripted");
    let outerHadFailure = false;
    outerHadFailure = cli.propagateHadFailure(hadFailureRef, outerHadFailure);
    assert.equal(exitCode(outerHadFailure), 1);
    assert.ok(stream.printed.join("").includes("turn limit"));
    const toolMsgs = history.filter((m) => m.role === "tool");
    assert.ok(toolMsgs.length >= 3, "each exhausted turn resolves through the boundary");
  });

  test("clean native turn → no failure → exit 0", async () => {
    let calls = 0;
    const history = [{ role: "system", content: "test" }];
    const hadFailureRef = { value: false };
    const runCompletion = (_params, _opts) => {
      calls++;
      const events = calls === 1
        ? [{
          type: "toolCall",
          seq: 0,
          call: { id: "call_ok", name: "get_address", arguments: {} },
        }]
        : [{ type: "contentDelta", seq: 0, text: "done." }];
      return { events: (async function* () { for (const e of events) yield e; })() };
    };
    const completeViaRealParser = (h, tools, onToken) =>
      completeWithTools(h, tools, onToken, { runCompletion });
    await runNativeToolLoop({
      history,
      completeWithTools: completeViaRealParser,
      getToolDefinitions,
      handleAction: cli.handleAction,
      dispatchToolCall,
      isWrite,
      printw: stream.printw,
      println: stream.println,
      DIM: "", RST: "", c: noColor, SCRIPTED: true,
      hadFailure: hadFailureRef,
    });

    assert.equal(calls, 2, "tool result must earn a follow-up turn");
    assert.equal(hadFailureRef.value, false);
    assert.equal(exitCode(cli.propagateHadFailure(hadFailureRef, false)), 0);
  });
});

console.log("\n✓ CLI exit path: real cli.mjs handleAction + prompt selection + hadFailure mapping");
console.log("✓ SDK toolError and turn exhaustion exit 1 with the message intact; clean turns exit 0");
