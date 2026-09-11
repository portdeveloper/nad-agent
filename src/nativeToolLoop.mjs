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
 */

/**
 * Run one full tool-turn loop against `history` (mutated in place: assistant and
 * tool messages are appended). The loop:
 *   1. Calls `completeWithTools(history, getToolDefinitions(), onToken)`.
 *   2. For each tool call, routes writes through `handleAction` (full safety
 *      boundary: resolveSend → policy → preview → mainnet ack → y/N) and reads
 *      through `dispatchToolCall`. The chosen return value is fed back as a
 *      tool-result message so the model can react.
 *   3. Repeats until the model emits no more tool calls, hits the per-turn
 *      cap, hits the global tool-call cap, or returns a toolCallError.
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
 * @param ctx.dispatchToolCall  read-only fast path; used for get_address / get_balance / get_token_balance.
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

  for (let turnCount = 0; turnCount < MAX_TURNS; turnCount++) {
    const result = await completeWithTools(history, getToolDefinitions(), (t) => printw(t));
    printw(RST + "\n");

    // Add assistant turn to history with its text and/or tool calls.
    const assistantContent = result.text || `[tool calls: ${result.toolCalls.map((c) => c.name).join(", ")}]`;
    history.push({ role: "assistant", content: assistantContent });

    // Surface tool call errors to the user.
    if (result.toolErrors && result.toolErrors.length > 0) {
      for (const toolErr of result.toolErrors) {
        println(c.red(`  tool error: ${toolErr.error || "malformed tool call"}`));
        if (SCRIPTED) hadFailure.value = true;
      }
      break; // Do not continue the loop if there were errors.
    }

    if (result.toolCalls && result.toolCalls.length > 0) {
      totalToolCalls += result.toolCalls.length;
      if (totalToolCalls > MAX_TOOL_CALLS) {
        println(c.red(`  tool call limit (${MAX_TOOL_CALLS}) exceeded; stopping.`) + "\n");
        if (SCRIPTED) hadFailure.value = true;
        break;
      }

      // Dispatch each tool call and collect results for history.
      const toolResults = [];
      for (const toolCall of result.toolCalls) {
        const action = { action: toolCall.name, ...toolCall.arguments };
        let execResult = null;

        try {
          // ROUTE THROUGH THE SAFETY BOUNDARY.
          //
          // Writes (send_mon, send_token, transfer_nft, swap, account-switch with
          // an index) MUST go through handleAction so they share the recipient
          // resolution, spend policy, preview, mainnet ack, and y/N confirmation
          // the v0 path and the slash commands already use. Anything else is a
          // read — dispatchToolCall is fine and stays snappy.
          if (isWrite(toolCall.name)) {
            execResult = await handleAction(action);
          } else {
            execResult = await dispatchToolCall(toolCall.name, toolCall.arguments);
          }
        } catch (err) {
          execResult = `Error: ${err.message || String(err)}`;
          if (SCRIPTED) hadFailure.value = true;
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
      println("");
      break;
    } else {
      // No text, no tool calls — model produced nothing.
      println("");
      break;
    }
  }
}
