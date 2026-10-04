/**
 * The native tool-calling loop: feeds a chat history into a QVAC-style completion
 * with tool definitions, dispatches every tool call the model emits, and keeps
 * looping until the model stops calling tools (or a limit is hit).
 *
 * Extracted from cli.mjs so the boundary that decides which tools must go through
 * `handleAction` (writes) versus `dispatchToolCall` (read-only) is reachable
 * from tests. The full REPL also imports this: every dependency (model, dispatch,
 * print helpers, mode flags) is passed in, so the same code drives both the
 * interactive REPL and a scripted test.
 *
 * This file hosts BOTH turn drivers and the one boundary they share:
 *   - runNativeToolLoop — MCP not connected: `completeWithTools` drives the turn.
 *   - runMcpTurn        — MCP connected: `completeWithMcp` drives the turn with
 *                         the built-in tools advertised alongside the servers',
 *                         and every call routed through dispatchNativeCall below.
 * Both exist so a native write cannot reach the wallet by any other road.
 */

import { isRefusal } from "./tools.mjs";

/**
 * Format one tool error for the operator, preserving the SDK message.
 *
 * completeWithTools returns the SDK `toolError` payload `{ code, message, raw? }`
 * (see agent.mjs). Older test doubles used the pre-fix whole-event shape
 * `{ error: <string|{message}> }`. Both are accepted here so a shape change can
 * never silently print "[object Object]" or "malformed tool call" while dropping
 * the real message the model needs to react to.
 */
export function formatToolError(toolErr) {
  if (typeof toolErr === "string") return toolErr;
  const nested = toolErr?.error;
  const nestedMsg =
    typeof nested === "string" ? nested : nested?.message ?? nested?.code ?? null;
  const message = toolErr?.message ?? nestedMsg ?? null;
  const code = toolErr?.code ?? (typeof nested === "object" ? nested?.code : null) ?? null;
  const text = message ?? "malformed tool call";
  return code ? `[${code}]: ${text}` : text;
}

/**
 * Route ONE native tool call through the safety boundary. This is the seam both
 * turn drivers share, and the reason it exists is a write:
 *
 *   ROUTE THROUGH THE SAFETY BOUNDARY.
 *
 * Writes (send_mon, send_token, transfer_nft, swap) and account-switch (account
 * with an index) MUST go through handleAction so they share the recipient
 * resolution, spend policy, preview, mainnet ack, and y/N confirmation the v0
 * path and the slash commands already use. Anything else is a read —
 * dispatchToolCall is fine and stays snappy.
 *
 * Returns `{ result, boundary }`. `boundary` says who printed it: handleAction
 * prints its own results and refusals as it produces them, dispatchToolCall
 * prints nothing — so a caller that also printed every result would show writes
 * twice and reads never.
 *
 * Throws are left to the caller: both turn drivers turn them into an
 * `Error: …` result and a scripted failure.
 *
 * @param call  { name, arguments } — one tool call from the model.
 * @param deps  { handleAction, dispatchToolCall, isWrite } — injected by cli.mjs
 *              so tests can prove which side of the seam answered.
 */
export async function dispatchNativeCall(
  { name, arguments: args = {} },
  { handleAction, dispatchToolCall, isWrite },
) {
  const isAccountSwitch =
    name === "account" &&
    args.index !== undefined &&
    args.index !== null &&
    args.index !== "";
  if (isWrite(name) || isAccountSwitch) {
    return { result: await handleAction({ action: name, ...args }), boundary: "handleAction" };
  }
  return { result: await dispatchToolCall(name, args), boundary: "dispatchToolCall" };
}

/**
 * Run one full tool-turn loop against `history` (mutated in place: assistant and
 * tool messages are appended). The loop:
 *   1. Calls `completeWithTools(history, getToolDefinitions(), onToken)`.
 *   2. For each tool call, routes writes through `handleAction` (full safety
 *      boundary: resolveSend → policy → preview → mainnet ack → y/N) and reads
 *      through `dispatchToolCall`. The chosen return value is fed back as a
 *      tool-result message so the model can react.
 *   3. Repeats until the model emits no more tool calls, hits the per-turn
 *      cap, hits the global tool-call cap, or returns a toolError.
 *
 * `handleAction` MUST be the same one cli.mjs uses for slash commands and the
 * v0 path — that is the whole point. `dispatchToolCall` is left in for the
 * read-only fast path; it never executes a write.
 *
 * @param ctx
 * @param ctx.history
 * @param ctx.completeWithTools
 * @param ctx.getToolDefinitions
 * @param ctx.handleAction  function taking an action object, returning a printable result string or null.
 * @param ctx.dispatchToolCall  read-only fast path for non-write tools.
 * @param ctx.isWrite  toolName -> boolean.
 * @param ctx.printw  write raw text to the active stream (no newline).
 * @param ctx.println  print a line to the active stream.
 * @param ctx.DIM  ANSI dim escape (or empty string when not a TTY).
 * @param ctx.RST  ANSI reset escape (or empty string when not a TTY).
 * @param ctx.c  color helpers.
 * @param ctx.SCRIPTED  boolean — when true, failures must set `hadFailure`.
 * @param ctx.hadFailure  mutable { value: boolean } reference shared with the REPL.
 * @param ctx.MAX_TOOL_CALLS  global per-turn tool-call cap (default 10).
 * @param ctx.MAX_TURNS  outer loop cap (default 10).
 */
export async function runNativeToolLoop({
  history,
  completeWithTools,
  getToolDefinitions,
  handleAction,
  dispatchToolCall,
  isWrite,
  printw,
  println,
  DIM,
  RST,
  c,
  SCRIPTED,
  hadFailure,
  MAX_TOOL_CALLS = 10,
  MAX_TURNS = 10,
}) {
  // Loop until the model stops calling tools. The outer cap is the wall; the
  // inner cap is the per-conversation tool-call budget.
  let totalToolCalls = 0;
  let lastTurnHadToolCalls = false;

  for (let turnCount = 0; turnCount < MAX_TURNS; turnCount++) {
    const result = await completeWithTools(history, getToolDefinitions(), (t) => printw(t));
    printw(RST + "\n");

    // Add assistant turn to history with its text and/or tool calls.
    const assistantContent = result.text || `[tool calls: ${result.toolCalls.map((c) => c.name).join(", ")}]`;
    history.push({ role: "assistant", content: assistantContent });

    // Surface tool call errors to the user. The message is preserved verbatim
    // (formatToolError handles both the SDK {code,message} payload and the
    // pre-fix whole-event shape) so the scripted failure path carries what the
    // SDK reported.
    if (result.toolErrors && result.toolErrors.length > 0) {
      for (const toolErr of result.toolErrors) {
        println(c.red(`  tool error: ${formatToolError(toolErr)}`));
        if (SCRIPTED) hadFailure.value = true;
      }
      break; // Do not continue the loop if there were errors.
    }

    if (result.toolCalls && result.toolCalls.length > 0) {
      lastTurnHadToolCalls = true;
      totalToolCalls += result.toolCalls.length;
      if (totalToolCalls > MAX_TOOL_CALLS) {
        println(c.red(`  tool call limit (${MAX_TOOL_CALLS}) exceeded; stopping.`) + "\n");
        if (SCRIPTED) hadFailure.value = true;
        break;
      }

      // Dispatch each tool call and collect results for history.
      const toolResults = [];
      for (const toolCall of result.toolCalls) {
        let execResult = null;

        try {
          // Through the shared boundary: writes → handleAction, reads →
          // dispatchToolCall (see dispatchNativeCall above).
          const routed = await dispatchNativeCall(toolCall, { handleAction, dispatchToolCall, isWrite });
          execResult = routed.result;
        } catch (err) {
          execResult = `Error: ${err.message || String(err)}`;
          if (SCRIPTED) hadFailure.value = true;
        }

        // A returned refusal is a failure too — same rule as the v0 path, which
        // checks isRefusal(out) and marks scripted runs failed. Applies to both
        // sides of the seam: reads refused by dispatchToolCall (e.g. get_nfts
        // with a bad address) and writes refused by handleAction. The flag is
        // sticky: a later clean turn must not clear it (no reset anywhere in
        // this loop), so a refusal followed by chat still exits non-zero.
        if (execResult != null && isRefusal(execResult) && SCRIPTED) {
          hadFailure.value = true;
        }

        if (execResult) {
          println("  " + c.cyan(String(execResult).replace(/\n/g, "\n  ")) + "\n");
        }

        toolResults.push({
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          result: execResult == null ? "" : String(execResult),
        });
      }

      // Add tool results to history as a tool message.
      if (toolResults.length > 0) {
        history.push({
          role: "tool",
          content: toolResults.map((r) => `${r.toolName}: ${r.result}`).join("\n"),
        });
        // Continue the loop to let the model respond with the tool results.
      }
    } else if (result.text) {
      // Model just chatted, no tool calls. Text already streamed.
      lastTurnHadToolCalls = false;
      println("");
      break;
    } else {
      // No text, no tool calls — model produced nothing.
      lastTurnHadToolCalls = false;
      println("");
      break;
    }
  }

  if (lastTurnHadToolCalls) {
    println(c.red(`  turn limit (${MAX_TURNS}) reached — the model is still calling tools; stopping.`) + "\n");
    if (SCRIPTED) hadFailure.value = true;
  }
}

/**
 * One turn with MCP servers connected — the counterpart of runNativeToolLoop.
 *
 * Advertising the built-in tools is only half the fix for "an MCP server
 * disables every wallet tool": the model can now emit BOTH kinds of call in one
 * turn, and each has to reach the right handler. So this driver:
 *
 *   1. Completes with `completeWithMcp({ mcpClients, tools })` — the SDK merges
 *      our tool definitions and the servers' into one request, so the prompt's
 *      promises and the model's catalogue match again.
 *   2. Routes every built-in call through dispatchNativeCall — the SAME
 *      handleAction boundary (resolve → policy → preview → mainnet ack → y/N)
 *      the slash commands, the v0 path and runNativeToolLoop use. An MCP server
 *      never answers a wallet action.
 *   3. Leaves MCP calls to `invokeToolCall`, which cli.mjs gates behind its own
 *      confirmation before any server sees the call.
 *   4. Folds refusals, thrown errors, SDK toolErrors and a hit round limit into
 *      `hadFailure`, so a scripted run still exits non-zero — the same
 *      propagateHadFailure mapping the native loop feeds.
 *
 * Printing follows each handler's own contract: handleAction prints its write
 * result itself (a second copy would be shown otherwise), while a read from
 * dispatchToolCall is printed here. A call that THREW was printed by neither —
 * the catch above does it, in red, once — so an operator always sees the cause
 * and does not have to wait for the model to repeat it. Every call sits in the
 * same RST/DIM frame cli.mjs used around the MCP gate, so a result is never
 * written while the model's dimmed stream is still open.
 *
 * Returns whatever `completeWithMcp` resolved to, so the caller can log the
 * round count or surface a limit.
 *
 * @param ctx
 * @param ctx.history            mutated in place: user/assistant/tool messages are appended.
 * @param ctx.mcpClients         connected clients (cli.mjs module state).
 * @param ctx.completeWithMcp    the real loop from agent.mjs (injectable seam).
 * @param ctx.getToolDefinitions our built-in tools, advertised alongside MCP's.
 * @param ctx.handleAction       the REAL CLI boundary — writes go here.
 * @param ctx.dispatchToolCall   read-only fast path.
 * @param ctx.isWrite            toolName -> boolean.
 * @param ctx.onToken            streams the model's own tokens.
 * @param ctx.invokeToolCall     the MCP gate (cli.mjs: confirm + invoke).
 * @param ctx.printw / ctx.DIM / ctx.RST  presentation frame.
 * @param ctx.println            line output (stdout interactive, stderr scripted).
 * @param ctx.c                  color helpers.
 * @param ctx.SCRIPTED           boolean — when true, failures must set hadFailure.
 * @param ctx.hadFailure         mutable { value: boolean } shared with the REPL.
 */
export async function runMcpTurn({
  history,
  mcpClients,
  completeWithMcp,
  getToolDefinitions,
  handleAction,
  dispatchToolCall,
  isWrite,
  onToken,
  invokeToolCall,
  printw,
  DIM,
  RST,
  println,
  c,
  SCRIPTED,
  hadFailure,
}) {
  // One frame per call: the model's tokens stream dimmed, so anything printed
  // while that is open would be dim too. RST before the result, DIM after.
  const framed = async (fn) => {
    printw(RST + "\n");
    try {
      return await fn();
    } finally {
      printw(DIM);
    }
  };

  const invokeNativeToolCall = async (call) => {
    let execResult = null;
    let boundary = "handleAction";
    try {
      const routed = await framed(() => dispatchNativeCall(call, { handleAction, dispatchToolCall, isWrite }));
      execResult = routed.result;
      boundary = routed.boundary;
    } catch (err) {
      // Nobody has printed this. The boundary that would have is the one that
      // threw, so `boundary` below still reads "handleAction" and the read-only
      // print would skip it: a scripted run would fail with only blank lines
      // for a cause, and an interactive one would depend on the model choosing
      // to repeat it. Say it here, once — the model still gets it as a result.
      execResult = `Error: ${err.message || String(err)}`;
      println("  " + c.red(String(execResult).replace(/\n/g, "\n  ")) + "\n");
      if (SCRIPTED) hadFailure.value = true;
      return execResult;
    }
    if (boundary === "dispatchToolCall" && execResult) {
      println("  " + c.cyan(String(execResult).replace(/\n/g, "\n  ")) + "\n");
    }
    // A returned refusal is a failure, same rule as the native loop and the
    // v0 path — so a refused write over MCP still exits non-zero in a script.
    if (execResult != null && isRefusal(execResult) && SCRIPTED) {
      hadFailure.value = true;
    }
    return execResult;
  };

  const result = await completeWithMcp(history, {
    mcpClients,
    tools: getToolDefinitions(),
    onToken,
    invokeToolCall: (call) => framed(() => invokeToolCall(call)),
    invokeNativeToolCall,
  });
  printw(RST + "\n");

  history.push({ role: "assistant", content: result.text });
  for (const e of result.toolErrors) {
    println(c.red(`  tool error [${e.code}]: ${e.message}`));
    if (SCRIPTED) hadFailure.value = true;
  }
  if (result.limitReached) {
    println(c.yellow(`  (stopped after ${result.rounds} tool-call rounds — the model kept calling tools)`));
    if (SCRIPTED) hadFailure.value = true;
  }
  println("");
  return result;
}
