/**
 * The wallet "tools" the agent can invoke, plus the NL->action interpreter.
 *
 * Design note: v0 uses a model-agnostic JSON-action protocol (works even on a
 * 360M dev model) rather than betting on any one model's native tool-calling.
 * On a big model (GPT_OSS_20B) you can swap this for QVAC's native tool calling
 * or the official @tetherto/wdk-mcp-toolkit MCP server — see README "Upgrade path".
 */

import * as wallet from "./wallet.mjs";
import { config } from "./config.mjs";
import { parseMon, formatMon, parseTokenAmount, isAddress } from "./format.mjs";

export const ACTIONS = {
  get_address: { args: [], desc: "Show the agent's own wallet address." },
  get_balance: { args: [], desc: "Show the agent's native MON balance." },
  send_mon: { args: ["to", "amountMon"], desc: "Send native MON to an address `to`, amount in MON as a string." },
  send_token: {
    args: ["token", "to", "amount"],
    desc: "Send an ERC-20 token. `token` is a symbol (USDC, WMON, ...) or a 0x contract address; `amount` is a human amount as a string.",
  },
  none: { args: [], desc: "The message is not an on-chain request; just reply in words." },
};

// Built-in token list, keyed by network. Addresses come from the official Monad
// token list (github.com/monad-crypto/token-list, tokenlist-testnet.json /
// tokenlist-mainnet.json) and each one was verified against the live RPC
// (eth_getCode + decimals()/symbol() reads) before being added here. Decimals
// are still read on-chain at send time — the list only resolves symbol -> address,
// so a stale entry can't mis-scale an amount. Raw 0x addresses work for any
// token not listed.
export const KNOWN_TOKENS = {
  testnet: {
    USDC: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
    WETH: "0x45477f4709771331db81944A5E20eF95Bc7BA2D7",
    WMON: "0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541",
  },
  mainnet: {
    USDC: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    USDT0: "0xe7cd86e13AC4309349F30B3435a9d337750fC82D",
    WETH: "0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242",
    WMON: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A",
  },
};

/**
 * Resolve a user-supplied token (symbol or 0x address) to a contract address on
 * the current network. Returns { address, symbol? } or null if unknown.
 */
export function resolveToken(input, network = config.chain.network) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  if (isAddress(raw)) return { address: raw };
  const symbol = raw.toUpperCase();
  const address = KNOWN_TOKENS[network]?.[symbol];
  return address ? { address, symbol } : null;
}

/** The symbols the current network's built-in list knows (for error messages/help). */
export function knownTokenSymbols(network = config.chain.network) {
  return Object.keys(KNOWN_TOKENS[network] ?? {});
}

const SYMBOL = () => config.chain.symbol;

/** Build the system prompt describing the tool protocol. */
export function systemPrompt() {
  const list = Object.entries(ACTIONS)
    .map(([name, { args, desc }]) => `- ${name}(${args.join(", ")}): ${desc}`)
    .join("\n");
  return (
    `You are nad-agent, a wallet assistant on ${config.chain.name}. You control a ` +
    `self-custodial smart account. When the user wants an on-chain action, respond ` +
    `with ONE line of JSON and nothing else, e.g. {"action":"send_mon","to":"0x...","amountMon":"0.5"} ` +
    `or {"action":"send_token","token":"USDC","to":"0x...","amount":"5"}.\n` +
    `Available actions:\n${list}\n` +
    `Known token symbols: ${knownTokenSymbols().join(", ")}. "send 5 USDC to 0x..." is send_token; ` +
    `"send 5 MON to 0x..." is send_mon.\n` +
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
  return action === "send_mon" || action === "send_token";
}

/** Human-readable preview of what an action will do (shown before confirmation). */
export function describeAction(a) {
  const gasNote = () =>
    config.gasMode === "dry-run" ? "  (DRY RUN — will be simulated)" : config.gasMode === "sponsored" ? "  (gasless)" : "  (you pay gas)";
  switch (a.action) {
    case "get_address":
      return "Read: your wallet address";
    case "get_balance":
      return "Read: your MON balance";
    case "send_mon":
      return `Send ${a.amountMon} ${SYMBOL()} -> ${a.to}` + gasNote();
    case "send_token": {
      const t = resolveToken(a.token);
      const label = t?.symbol ?? a.token;
      return `Send ${a.amount} ${label} (ERC-20) -> ${a.to}` + gasNote();
    }
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

    case "send_token": {
      if (!isAddress(a.to)) return `Refused: "${a.to}" is not a valid address.`;
      const t = resolveToken(a.token);
      if (!t) {
        return (
          `Refused: unknown token "${a.token}". Use a 0x contract address, or one of: ` +
          `${knownTokenSymbols().join(", ")}.`
        );
      }
      // Decimals come from the token contract itself, never from the list — the
      // read also proves there is real ERC-20 code at the address before we send.
      let meta;
      try {
        meta = await wallet.getTokenMeta(t.address);
      } catch (err) {
        return `Refused: ${err.message}`;
      }
      const label = meta.symbol || t.symbol || t.address;
      let amount;
      try {
        amount = parseTokenAmount(a.amount, meta.decimals);
      } catch {
        return `Refused: "${a.amount}" is not a valid ${label} amount (${meta.decimals} decimals).`;
      }
      if (amount <= 0n) return `Refused: the amount must be greater than zero.`;
      const res = await wallet.sendToken(t.address, a.to, amount);
      if (res.dryRun) {
        return (
          `DRY RUN — would send ${a.amount} ${label} to ${a.to}\n` +
          `  token: ${t.address}\n` +
          `  (est. fee ${formatMon(res.fee)} ${SYMBOL()}). Set PIMLICO_API_KEY in .env to broadcast for real.`
        );
      }
      if (res.hash) {
        const url = `${config.chain.explorerUrl}/tx/${res.hash}`;
        return (
          `Sent ${a.amount} ${label} to ${a.to}\n` +
          `  token:  ${t.address}\n` +
          `  tx:     ${res.hash}\n  ${url}\n` +
          `  userOp: ${res.userOpHash}`
        );
      }
      return (
        `Submitted ${a.amount} ${label} to ${a.to} (gasless UserOp)\n` +
        `  userOp: ${res.userOpHash}\n` +
        `  (not confirmed on-chain yet — should land shortly)`
      );
    }

    default:
      return null; // caller falls back to a plain chat reply
  }
}
