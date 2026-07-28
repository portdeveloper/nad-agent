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
import { readGgufChatTemplate } from "./gguf.mjs";

let modelId = null;
let supportsNativeTools = false; // set during loadBrain

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

  // Decide the tool-calling path for this model. The ground truth for a local
  // .gguf is its own chat template: a model trained for native tool-calling
  // references a `tools` variable there ({%- if tools %} in Qwen3/Llama-3.x/
  // Hermes), while e.g. SmolLM2's template has no tools block at all, so the
  // rendered prompt would never show the declarations and completion({ tools })
  // silently degrades to plain chat. Registry models don't expose the template
  // before download, so fall back to a name heuristic there. Env override:
  // NAD_TOOLCALLING=native|legacy skips detection either way.
  const override = (process.env.NAD_TOOLCALLING || "").toLowerCase();
  if (override === "native") {
    supportsNativeTools = true;
  } else if (override === "legacy") {
    supportsNativeTools = false;
  } else if (config.model.localPath) {
    const tpl = readGgufChatTemplate(config.model.localPath);
    supportsNativeTools = tpl != null && /\btools\b/.test(tpl);
  } else {
    // Registry name heuristic: families QVAC's dialect router knows and whose
    // templates render tools (ChatML/hermes Qwen3, harmony gpt-oss, Llama-3.x
    // tool-calling finetunes).
    supportsNativeTools = /QWEN3|GPT_OSS|TOOL_CALLING|HERMES/.test(config.model.name || "");
  }

  modelId = await loadModel(
    {
      ...src,
      modelConfig: {
        ctx_size: config.model.ctxSize,
        predict: config.model.maxTokens, // cap generation (llama.cpp n_predict)
        temp: 0, // deterministic action routing
        // Native path: turns on jinja tool templating in the addon. Off on the
        // legacy path so the v0 prompt is byte-identical to before.
        tools: supportsNativeTools,
      },
      onProgress,
    },
    { timeout: 600_000 } // registry fetch of a big model can take minutes on first run
  );
  return modelId;
}

/**
 * Run a completion, streaming tokens to `onToken`. Pass `tools` (Tool[]) to use
 * the native path. Returns { text, toolCalls, native }:
 *   native:true  -> `toolCalls` is authoritative. Empty means the model chose to
 *                   chat, so the caller must NOT string-parse the text: a
 *                   reasoning model narrates tool names it decided not to call
 *                   and the v0 lenient parser would fire on that prose.
 *   native:false -> caller string-parses `text` with the v0 protocol.
 * A mid-stream model error degrades to native:false so partial text still gets
 * the lenient treatment it got before this change.
 */
export async function complete(history, onToken, tools) {
  const { completion } = await qvac();
  const useNative = supportsNativeTools && tools != null && tools.length > 0;
  const run = completion(
    { modelId, history, stream: true, ...(useNative && { tools }) },
    { timeout: 300_000 }
  );
  let out = "";
  try {
    for await (const token of run.tokenStream) {
      out += token;
      if (onToken) onToken(token);
    }
    if (useNative) {
      // Resolved once the wire stream is done; the SDK has run its dialect
      // parser (hermes / qwen35 / harmony / pythonic) over the raw output.
      return { text: out, toolCalls: await run.toolCalls, native: true };
    }
  } catch (err) {
    // A model-side error (e.g. CONTEXT_OVERFLOW) must not crash the agent — keep
    // whatever was produced and let the caller decide what to do with it.
    if (onToken) onToken(`\n[model stopped: ${err.code || err.message}]`);
  }
  return { text: out, toolCalls: [], native: false };
}

/** True if the loaded model was set up for QVAC native tool-calling. */
export function usesNativeTools() {
  return supportsNativeTools;
}

export async function unloadBrain() {
  if (!modelId) return;
  const { unloadModel } = await qvac();
  await unloadModel({ modelId, clearStorage: false });
  modelId = null;
}
