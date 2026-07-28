/**
 * The wallet "tools" the agent can invoke, plus the NL->action interpreter.
 *
 * Design note: v0 uses a model-agnostic JSON-action protocol (works even on a
 * 360M dev model) rather than betting on any one model's native tool-calling.
 * On a big model (GPT_OSS_20B) you can swap this for QVAC's native tool calling
 * or the official @tetherto/wdk-mcp-toolkit MCP server — see README "Upgrade path".
 */

import { getAddress } from "ethers";
import * as wallet from "./wallet.mjs";
import { config } from "./config.mjs";
import { parseMon, formatMon, isAddress } from "./format.mjs";

export const ACTIONS = {
  get_address: { args: [], desc: "Show the agent's own wallet address." },
  get_balance: { args: [], desc: "Show the agent's native MON balance." },
  send_mon: { args: ["to", "amountMon"], desc: "Send native MON to an address `to`, amount in MON as a string." },
  none: { args: [], desc: "The message is not an on-chain request; just reply in words." },
};

const SYMBOL = () => config.chain.symbol;

/** Build the system prompt describing the tool protocol. */
export function systemPrompt() {
  const list = Object.entries(ACTIONS)
    .map(([name, { args, desc }]) => `- ${name}(${args.join(", ")}): ${desc}`)
    .join("\n");
  return (
    `You are nad-agent, a wallet assistant on ${config.chain.name}. You control a ` +
    `self-custodial smart account. When the user wants an on-chain action, respond ` +
    `with ONE line of JSON and nothing else, e.g. {"action":"send_mon","to":"0x...","amountMon":"0.5"}.\n` +
    `Available actions:\n${list}\n` +
    `If it isn't an on-chain request, use {"action":"none"}. Never invent addresses.`
  );
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

/**
 * Validate and checksum a send recipient.
 * Returns { address } on success or { error } if the input is not a valid address.
 * A typo'd checksum (wrong case on a mixed-case address) is rejected here before
 * the confirmation prompt, satisfying the acceptance criterion.
 */
export function resolveRecipient(raw) {
  if (!raw || !isAddress(raw.trim())) {
    return { error: `"${raw}" is not a valid 0x address.` };
  }
  try {
    return { address: getAddress(raw.trim()) }; // throws on bad checksum
  } catch {
    return { error: `"${raw}" has an invalid checksum. Did you mean ${getAddress(raw.trim().toLowerCase())}?` };
  }
}

/**
 * Build the pre-send confirmation block. Returns { block, to, amountWei } or
 * { error } when the recipient or amount is invalid. Called by cli.mjs before
 * the yes/no prompt so the user sees exactly what is about to happen. One
 * balance read is done here (plus a fee quote in dry-run); no further RPC
 * calls are made before the send executes.
 */
export async function buildConfirmBlock(a) {
  const { address: to, error } = resolveRecipient(a.to);
  if (error) return { error };

  let amountWei;
  try {
    amountWei = parseMon(a.amountMon);
    if (amountWei <= 0n) return { error: `amount must be positive, got "${a.amountMon}".` };
  } catch {
    return { error: `"${a.amountMon}" is not a valid ${SYMBOL()} amount.` };
  }
  const sym = SYMBOL();

  // What the balance arrow means per mode:
  //   sponsored -> paymaster covers gas, so after = before - amount exactly
  //   dry-run   -> nothing broadcasts; the arrow is a simulation
  //   native    -> gas comes out of the balance too, on top of the amount
  const balanceNote =
    config.gasMode === "sponsored" ? " (no gas deducted, sponsored)"
    : config.gasMode === "dry-run" ? " (simulated)"
    : " (plus gas)";

  // One balance read — used for both current and post-send display.
  let balBefore = null;
  let balAfterStr = "unknown";
  try {
    balBefore = await wallet.getBalance();
    const postSend = balBefore - amountWei;
    balAfterStr = postSend < 0n
      ? `${formatMon(postSend)} ${sym} — insufficient balance`
      : `${formatMon(postSend)} ${sym}${balanceNote}`;
  } catch {
    /* balance read is best-effort */
  }

  const gasLine =
    config.gasMode === "sponsored"
      ? "gasless via paymaster (you pay 0 gas)"
      : config.gasMode === "dry-run"
        ? "dry-run simulation (no broadcast)"
        : "native gas (deducted from your balance in MON)";

  // Dry-run: attempt a fee quote so the user sees the simulated outcome.
  let simulationLine = null;
  if (config.gasMode === "dry-run") {
    try {
      const q = await wallet.quoteSend(to, amountWei);
      const fee = BigInt(q?.fee ?? 0);
      simulationLine = `simulated outcome: would send ${a.amountMon} ${sym}, est. fee ${formatMon(fee)} ${sym}`;
    } catch {
      simulationLine = "simulated outcome: fee estimation unavailable (no bundler in dry-run)";
    }
  }

  const lines = [
    `recipient : ${to}`,
    `amount    : ${a.amountMon} ${sym}`,
    `balance   : ${balBefore !== null ? `${formatMon(balBefore)} ${sym}` : "unknown"} -> ${balAfterStr}`,
    `gas       : ${gasLine}`,
  ];
  if (simulationLine) lines.push(simulationLine);

  return { block: lines.join("\n"), to, amountWei };
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
      const { address: to, error } = resolveRecipient(a.to);
      if (error) return `Refused: ${error}`;
      const value = parseMon(a.amountMon);
      const res = await wallet.send(to, value);
      if (res.dryRun) {
        return (
          `DRY RUN — would send ${a.amountMon} ${SYMBOL()} to ${to}\n` +
          `  (est. fee ${formatMon(res.fee)} ${SYMBOL()}). Set PIMLICO_API_KEY in .env to broadcast for real.`
        );
      }
      if (res.hash) {
        const url = `${config.chain.explorerUrl}/tx/${res.hash}`;
        return (
          `Sent ${a.amountMon} ${SYMBOL()} to ${to}\n` +
          `  tx:     ${res.hash}\n  ${url}\n` +
          `  userOp: ${res.userOpHash}`
        );
      }
      // Broadcast, but the receipt hasn't landed within the wait window.
      return (
        `Submitted ${a.amountMon} ${SYMBOL()} to ${to} (gasless UserOp)\n` +
        `  userOp: ${res.userOpHash}\n` +
        `  (not confirmed on-chain yet — should land shortly; re-check /balance)`
      );
    }

    default:
      return null; // caller falls back to a plain chat reply
  }
}
