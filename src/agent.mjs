/**
 * The local AI brain — Tether QVAC running a GGUF model fully on-device (CPU here,
 * Metal on an M4 Max). No cloud, no API keys. Verified working: loadModel +
 * streaming completion (SmolLM2-360M ran at ~127 tok/s on plain Node here).
 *
 * QVAC is native (built on Bare), so it must stay OUT of the esbuild bundle and
 * resolve from node_modules at runtime — that's how the right per-platform
 * prebuild (linux-arm64 / darwin-arm64-Metal) gets loaded on each machine.
 */

import { config } from "./config.mjs";

let modelId = null;

// Kept external from the bundle; imported lazily so `--doctor`/help work uninstalled.
const qvac = () => import("@qvac/sdk");

async function resolveModelSrc() {
  if (config.model.localPath) {
    // Local GGUF: bypasses the P2P registry and its hard 60s download timeout.
    return { modelSrc: config.model.localPath, modelType: "llamacpp-completion" };
  }
  const models = await import("@qvac/sdk/models");
  const src = models[config.model.name];
  if (!src) {
    const avail = Object.keys(models)
      .filter((k) => /INST|CHAT|OSS|QWEN|SMOLLM|LLAMA/.test(k))
      .join(", ");
    throw new Error(
      `Unknown QVAC_MODEL "${config.model.name}".\n` +
        `Available completion models: ${avail}\n` +
        `Or set QVAC_MODEL_PATH to a local .gguf (see: npm run fetch-model).`
    );
  }
  return { modelSrc: src };
}

export async function loadBrain(onProgress) {
  const { loadModel } = await qvac();
  const src = await resolveModelSrc();
  modelId = await loadModel(
    {
      ...src,
      modelConfig: {
        ctx_size: config.model.ctxSize,
        predict: config.model.maxTokens, // cap generation (llama.cpp n_predict)
        temp: 0, // deterministic action routing
      },
      onProgress,
    },
    { timeout: 600_000 } // registry fetch of a big model can take minutes on first run
  );
  return modelId;
}

/** Run a completion, streaming tokens to `onToken`. Returns the full text. */
export async function complete(history, onToken) {
  const { completion } = await qvac();
  const run = completion({ modelId, history, stream: true }, { timeout: 300_000 });
  let out = "";
  try {
    for await (const token of run.tokenStream) {
      out += token;
      if (onToken) onToken(token);
    }
  } catch (err) {
    // A model-side error (e.g. CONTEXT_OVERFLOW) must not crash the agent — keep
    // whatever was produced and let the caller decide what to do with it.
    if (onToken) onToken(`\n[model stopped: ${err.code || err.message}]`);
  }
  return out;
}

/**
 * Run a completion against one or more connected MCP servers (see mcp.mjs),
 * feeding each tool call's result back into `history` and re-completing until
 * the model stops calling tools — or `maxToolRounds` is hit, so a runaway
 * tool-call loop cannot hang the agent forever.
 *
 * `invokeToolCall(call)` executes one call and must resolve to a string for
 * history; this function has no UI, so confirmation/refusal is entirely the
 * caller's decision (cli.mjs gates every call behind a y/N prompt).
 *
 * `runCompletion` is a test seam — it defaults to QVAC's own `completion()`,
 * lazily imported like every other QVAC call in this file, but a caller can
 * inject a fake `{ events, final }` producer to drive the loop without a
 * live model or MCP server.
 *
 * Never throws on a model-side error (same rule as complete()); returns
 * `{ text, rounds, toolErrors, limitReached }` so the caller can decide how
 * to report a stopped model, a tool error, or a hit round limit.
 */
export async function completeWithMcp(
  history,
  { mcpClients = [], onToken, invokeToolCall, maxToolRounds = 8, runCompletion } = {},
) {
  const doCompletion = runCompletion ?? (await qvac()).completion;
  const mcp = mcpClients.map((c) => ({ client: c.client, includeResources: false }));
  const toolErrors = [];
  let text = "";
  let rounds = 0;

  for (;;) {
    const run = doCompletion({ modelId, history, mcp, stream: true }, { timeout: 300_000 });
    try {
      for await (const event of run.events) {
        if (event.type === "contentDelta") {
          if (onToken) onToken(event.text);
        } else if (event.type === "toolError") {
          toolErrors.push(event.error);
        }
      }
    } catch (err) {
      if (onToken) onToken(`\n[model stopped: ${err.code || err.message}]`);
      return { text, rounds, toolErrors, limitReached: false };
    }

    const final = await run.final;
    text = final.contentText ?? final.raw?.fullText ?? "";
    const toolCalls = final.toolCalls ?? [];
    if (toolCalls.length === 0) {
      return { text, rounds, toolErrors, limitReached: false };
    }

    rounds++;
    if (rounds > maxToolRounds) {
      return { text, rounds: rounds - 1, toolErrors, limitReached: true };
    }

    // Intermediate turns are internal to the loop and not otherwise visible, so
    // they are pushed here; the final round's assistant text is left for the
    // caller to push, matching how complete() leaves that to its caller too.
    history.push({ role: "assistant", content: text });
    for (const call of toolCalls) {
      if (!invokeToolCall) {
        throw new Error("completeWithMcp: invokeToolCall is required when the model calls a tool");
      }
      const result = await invokeToolCall(call);
      history.push({ role: "tool", content: String(result ?? "") });
    }
  }
}

export async function unloadBrain() {
  if (!modelId) return;
  const { unloadModel } = await qvac();
  await unloadModel({ modelId, clearStorage: false });
  modelId = null;
}
