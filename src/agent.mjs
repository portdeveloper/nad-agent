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
 * Run a completion with native tool-calling.
 * Returns { text, toolCalls, toolErrors } where toolCalls is an array of { id, name, arguments }
 * and toolErrors is an array of { toolCallId, error, details }.
 */
export async function completeWithTools(history, tools, onToken) {
  const { completion } = await qvac();
  const run = completion({ modelId, history, tools, stream: true }, { timeout: 300_000 });
  let text = "";
  const toolCalls = [];
  const toolErrors = [];

  try {
    for await (const event of run.events) {
      if (event.type === "contentDelta") {
        text += event.text;
        if (onToken) onToken(event.text);
      } else if (event.type === "toolCall") {
        toolCalls.push(event.call);
      } else if (event.type === "toolCallError") {
        toolErrors.push(event);
      }
    }
  } catch (err) {
    // A model-side error must not crash the agent, but surface it to the caller.
    throw err;
  }

  return { text, toolCalls, toolErrors };
}

export async function unloadBrain() {
  if (!modelId) return;
  const { unloadModel } = await qvac();
  await unloadModel({ modelId, clearStorage: false });
  modelId = null;
}
