/**
 * The wallet "tools" the agent can invoke, plus the NL->action interpreter.
 *
 * v1 design (this change): when the model supports native tool-calling (its
 * GGUF chat template renders tools, e.g. Qwen3 or a Llama-3.x tool finetune),
 * we pass Tool[] declarations to completion({ tools }) and read structured
 * ToolCall[] responses. Otherwise we fall back to the v0 JSON-action protocol
 * (works on SmolLM2-360M). Both paths produce the same action object, so the
 * confirm-and-run flow downstream is untouched.
 *
 * To force a path: NAD_TOOLCALLING=native (always declare tools; a model whose
 * template can't render them just answers in prose and nothing is routed) or
 * NAD_TOOLCALLING=legacy (always v0 JSON). Unset = auto-detect in agent.mjs.
 */

import * as wallet from "./wallet.mjs";
import { config } from "./config.mjs";
import { parseMon, formatMon, isAddress } from "./format.mjs";

export const ACTIONS = {
  get_address: { args: [], desc: "Show the agent's own wallet address." },
  get_balance: { args: [], desc: "Show the agent's native MON balance." },
  send_mon: { args: ["to", "amountMon"], desc: "Send native MON to an address `to`, amount in MON as a string." },
  none: { args: [], desc: "The message is not an on-chain request; just reply in words." },
};

// QVAC native tool declarations: Tool[] with JSON Schema parameters. The SDK
// accepts either this shape or a ToolInput with Zod schemas; we go SDK-native.
export const NATIVE_TOOLS = [
  {
    type: "function",
    name: "get_address",
    description: "Show the agent's own wallet address.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "get_balance",
    description: "Show the agent's native MON balance.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "send_mon",
    description: "Send native MON to an address.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient 0x address" },
        amountMon: { type: "string", description: "Amount in MON, as a string (e.g. '0.5')" },
      },
      required: ["to", "amountMon"],
    },
  },
];

const SYMBOL = () => config.chain.symbol;

/** Build the system prompt describing the tool protocol (v0 JSON or native). */
export function systemPrompt(nativeTools) {
  const base = `You are nad-agent, a wallet assistant on ${config.chain.name}. You control a self-custodial smart account.`;
  if (nativeTools) {
    return (
      base +
      ` When the user wants an on-chain action, use the provided tools. If it isn't an on-chain request, reply in words.`
    );
  }
  const list = Object.entries(ACTIONS)
    .map(([name, { args, desc }]) => `- ${name}(${args.join(", ")}): ${desc}`)
    .join("\n");
  return (
    base +
    ` When the user wants an on-chain action, respond with ONE line of JSON and nothing else, e.g. {"action":"send_mon","to":"0x...","amountMon":"0.5"}.\n` +
    `Available actions:\n${list}\n` +
    `If it isn't an on-chain request, use {"action":"none"}. Never invent addresses.`
  );
}

/**
 * Turn a `complete()` result into an action. This is the one place that decides
 * which protocol read the model, so both the REPL and the smoke agree.
 *
 * On the native path `toolCalls` is authoritative and an empty array means "the
 * model chose to chat". We must not string-parse the text in that case: a
 * reasoning model narrates the tools it considered ("There's a function called
 * get_balance…") and parseAction's lenient branch matches a bare action name
 * anywhere in the text, so it would run a read the model never requested.
 */
export function resolveAction(res) {
  if (res.native) {
    return res.toolCalls.length > 0 ? actionFromToolCall(res.toolCalls[0]) : { action: "none" };
  }
  return parseAction(res.text);
}

/**
 * Map a QVAC native ToolCall to the same action object the v0 parser produces,
 * so the confirm-and-run path downstream doesn't care which path produced it.
 * Unknown names (a model inventing a tool) degrade to {action:"none"}.
 */
export function actionFromToolCall(call) {
  if (!call || !ACTIONS[call.name]) return { action: "none" };
  const args = call.arguments ?? {};
  const action = { action: call.name };
  for (const key of ACTIONS[call.name].args) {
    if (args[key] != null) action[key] = String(args[key]);
  }
  return action;
}

/** Extract an action from a model response: JSON first, then a lenient fallback. */
export function parseAction(text) {
  const m = text.match(/\{[\s\S]*?\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      if (obj.action && ACTIONS[obj.action]) return obj;
    } catch {
      /* fall through to the lenient path */
    }
  }
  // Small models often emit `get_balance()` instead of JSON. Recognize a READ-ONLY
  // action name in the text — but never auto-trigger a write (send needs real args).
  for (const name of ["get_balance", "get_address"]) {
    if (new RegExp(`\\b${name}\\b`).test(text)) return { action: name };
  }
  return { action: "none" };
}

/** True if the action mutates chain state and should require confirmation. */
export function isWrite(action) {
  return action === "send_mon";
}

/** Human-readable preview of what an action will do (shown before confirmation). */
export function describeAction(a) {
  switch (a.action) {
    case "get_address":
      return "Read: your wallet address";
    case "get_balance":
      return "Read: your MON balance";
    case "send_mon":
      return `Send ${a.amountMon} ${SYMBOL()} -> ${a.to}` +
        (config.gasMode === "dry-run" ? "  (DRY RUN — will be simulated)" : config.gasMode === "sponsored" ? "  (gasless)" : "  (you pay gas)");
    default:
      return "No on-chain action";
  }
}

/** Execute an action. Returns a printable string. Assumes wallet is initialized for chain ops. */
export async function runAction(a) {
  switch (a.action) {
    case "get_address":
      return wallet.getAddress() ?? "(wallet not initialized)";

    case "get_balance": {
      const bal = await wallet.getBalance();
      return `${formatMon(bal)} ${SYMBOL()}`;
    }

    case "send_mon": {
      if (!isAddress(a.to)) return `Refused: "${a.to}" is not a valid address.`;
      const value = parseMon(a.amountMon);
      const res = await wallet.send(a.to, value);
      if (res.dryRun) {
        return (
          `DRY RUN — would send ${a.amountMon} ${SYMBOL()} to ${a.to}\n` +
          `  (est. fee ${formatMon(res.fee)} ${SYMBOL()}). Set PIMLICO_API_KEY in .env to broadcast for real.`
        );
      }
      if (res.hash) {
        const url = `${config.chain.explorerUrl}/tx/${res.hash}`;
        return (
          `Sent ${a.amountMon} ${SYMBOL()} to ${a.to}\n` +
          `  tx:     ${res.hash}\n  ${url}\n` +
          `  userOp: ${res.userOpHash}`
        );
      }
      // Broadcast, but the receipt hasn't landed within the wait window.
      return (
        `Submitted ${a.amountMon} ${SYMBOL()} to ${a.to} (gasless UserOp)\n` +
        `  userOp: ${res.userOpHash}\n` +
        `  (not confirmed on-chain yet — should land shortly; re-check /balance)`
      );
    }

    default:
      return null; // caller falls back to a plain chat reply
  }
}
