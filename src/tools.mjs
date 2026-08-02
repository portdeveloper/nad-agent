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
import { parseMon, formatMon, formatTokenUnits, parseTokenAmount, isAddress } from "./format.mjs";
import { listKnownTokenSymbols, resolveToken } from "./tokens.mjs";
import { resolveRecipient, formatRecipient } from "./addressBook.mjs";

export const ACTIONS = {
  get_address: { args: [], desc: "Show the agent's own wallet address." },
  get_balance: { args: [], desc: "Show the agent's native MON balance." },
  get_token_balance: {
    args: ["token"],
    desc: "Show an ERC-20 token balance by token symbol or contract address.",
  },
  send_mon: { args: ["to", "amountMon"], desc: "Send native MON to `to` — a 0x address or an address-book name — amount in MON as a string." },
  send_token: {
    args: ["token", "to", "amount"],
    desc: "Send an ERC-20 token to `to` — a 0x address or an address-book name. `token` is a symbol (e.g. USDC) or contract address. `amount` is a human-readable string.",
  },
  none: { args: [], desc: "The message is not an on-chain request; just reply in words." },
};

const SYMBOL = () => config.chain.symbol;
const isNativeToken = (token) => String(token ?? "").trim().toUpperCase() === SYMBOL();
const ADDRESS_RE = /\b0x[0-9a-fA-F]{40}\b/;
const looksLikeBalanceQuestion = (text) => /\b(balance|bal|holding|holdings)\b/i.test(text);

function parseTokenBalancePhrase(text) {
  if (!looksLikeBalanceQuestion(text)) return null;

  const address = text.match(ADDRESS_RE)?.[0];
  if (address) return { action: "get_token_balance", token: address };

  const upper = text.toUpperCase();
  if (new RegExp(`\\b${SYMBOL()}\\b`).test(upper)) return { action: "get_balance" };

  for (const symbol of listKnownTokenSymbols()) {
    if (new RegExp(`\\b${symbol}\\b`).test(upper)) {
      return { action: "get_token_balance", token: symbol };
    }
  }

  return null;
}

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
      const token = obj.token ?? obj.symbol ?? obj.tokenAddress;
      if (obj.action === "get_balance" && token && !isNativeToken(token)) {
        return { action: "get_token_balance", token };
      }
      if (obj.action && ACTIONS[obj.action]) return obj;
    } catch {
      /* fall through to the lenient path */
    }
  }
  // Small models often emit `get_balance()` instead of JSON. Recognize READ-ONLY
  // action names in the text — but never auto-trigger a write (send needs real args).
  const tokenBalanceCall = text.match(/\bget_token_balance\s*\(\s*["']?([^"')\s,]+)["']?\s*\)/i);
  if (tokenBalanceCall) return { action: "get_token_balance", token: tokenBalanceCall[1] };
  const balanceWithTokenCall = text.match(/\bget_balance\s*\(\s*["']?([^"')\s,]+)["']?\s*\)/i);
  if (balanceWithTokenCall) {
    const token = balanceWithTokenCall[1];
    return isNativeToken(token) ? { action: "get_balance" } : { action: "get_token_balance", token };
  }

  const tokenBalancePhrase = parseTokenBalancePhrase(text);
  if (tokenBalancePhrase) return tokenBalancePhrase;

  for (const name of ["get_balance", "get_address"]) {
    if (new RegExp(`\\b${name}\\b`).test(text)) return { action: name };
  }
  return { action: "none" };
}

/**
 * Resolve a send's recipient ONCE, before anything is shown or signed.
 *
 * Callers refuse before prompting: asking someone to confirm a transfer that is already
 * going to be declined teaches them the prompt is a formality.
 */
export function resolveSend(a) {
  if (!isWrite(a.action)) return { ok: true, recipient: null };
  const r = resolveRecipient(a.to);
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, recipient: r };
}

/** True if the action mutates chain state and should require confirmation. */
export function isWrite(action) {
  return action === "send_mon" || action === "send_token";
}

/** Human-readable preview of what an action will do (shown before confirmation). */
export function describeAction(a, resolved) {
  switch (a.action) {
    case "get_address":
      return "Read: your wallet address";
    case "get_balance":
      return "Read: your MON balance";
    case "get_token_balance":
      return `Read: your ${a.token ?? a.symbol ?? a.tokenAddress ?? "token"} token balance`;
    case "send_mon": {
      // `resolved` is a separate argument, never a field on `a`: `a` is built from model
      // output. There is deliberately no fallback that resolves here — a second resolution
      // path would re-read the book at display time, and the gap before the operator presses
      // y is exactly when the file can change. No resolution means no address to approve.
      const target = resolved?.ok ? formatRecipient(resolved) : "[recipient not resolved]";
      return `Send ${a.amountMon} ${SYMBOL()} -> ${target}` +
        (config.gasMode === "dry-run" ? "  (DRY RUN — will be simulated)" : config.gasMode === "sponsored" ? "  (gasless)" : "  (you pay gas)");
    }
    case "send_token": {
      // Same rule as send_mon: the line the operator approves shows what was resolved, never
      // the raw model output. isWrite() covers send_token, so resolveSend() has already run.
      const label = a.tokenSymbol || a.token || "token";
      const dest = resolved?.ok ? formatRecipient(resolved) : "[recipient not resolved]";
      return `Send ${a.amount} ${label} -> ${dest}` +
        (config.gasMode === "dry-run" ? "  (DRY RUN — will be simulated)" : config.gasMode === "sponsored" ? "  (gasless)" : "  (you pay gas)");
    }
    default:
      return "No on-chain action";
  }
}

/**
 * Pre-flight a send for the confirmation block. Takes the ALREADY-RESOLVED
 * checksummed recipient (the caller resolves once, so an address-book name
 * from #42 can be mapped before this runs), reads the balance, and simulates
 * fee + post-send balance so the user sees the effect before approving.
 */
export async function previewSend(a, to) {
  const value = parseMon(a.amountMon);
  const before = await wallet.getBalance();
  // Known follow-up: this compares against the amount alone; a native-gas send
  // that only reverts because of the added fee shows no warning here.
  const insufficient = value > before;
  // Best-effort fee simulation; never blocks the preview if the quote path errors.
  let fee = 0n;
  let simulated = false;
  let simError = null;
  try {
    const q = await wallet.quoteSend(to, value);
    fee = BigInt(q?.fee ?? 0);
    simulated = true;
  } catch (err) {
    // The simulation itself failed: surface it as a possible revert so an
    // obvious failure is caught before the confirmation prompt.
    simError = err?.shortMessage || err?.message || "simulation failed";
  }
  const paysGas = config.gasMode === "native";
  const after = before - value - (paysGas ? fee : 0n);
  const gasLabel =
    config.gasMode === "sponsored" ? "gasless (paymaster covers fee)"
    : config.gasMode === "dry-run" ? "dry-run (simulated, nothing broadcast)"
    : "you pay gas in " + SYMBOL();
  return { to, amountMon: a.amountMon, symbol: SYMBOL(), value, fee, simulated,
           before, after, gasLabel, paysGas, insufficient, simError };
}

/** Render the previewSend result as the confirmation block shown before y/N. */
export function renderSendPreview(p) {
  const lines = [
    `To:       ${p.to}`,
    `Amount:   ${p.amountMon} ${p.symbol}`,
    `Gas:      ${p.gasLabel}` + (p.simulated && p.fee > 0n ? `  (~${formatMon(p.fee)} ${p.symbol})` : ""),
    `Balance:  ${formatMon(p.before)} -> ${formatMon(p.after)} ${p.symbol}`,
  ];
  if (p.insufficient) {
    lines.push(`WARNING:  balance is below the amount — this send would revert.`);
  }
  if (p.simError && !p.insufficient) {
    lines.push(`WARNING:  simulation failed, this send may revert (${p.simError}).`);
  }
  return lines.join("\n");
}

/** Execute an action. Returns a printable string. Assumes wallet is initialized for chain ops. */
export async function runAction(a, resolved) {
  // Read `resolved.address` once, here, and use that copy everywhere below: a getter or a
  // Proxy that answers the check with a valid address and the signature with another one is
  // otherwise free to do so. Padding is refused rather than trimmed, because isAddress()
  // trims internally and " 0x… " would reach the confirm line ragged. isAddress() rejects
  // every non-string, and `||` short-circuits before .trim().
  //
  // No fallback that resolves here when the argument is missing: a second resolution path
  // would re-read the book after the operator approved, and the gap before they press y is
  // exactly when the file can change. Direct callers resolve through resolveSend() first.
  const to = resolved?.address;
  if (isWrite(a.action) && (resolved?.ok !== true || !isAddress(to) || to !== to.trim())) {
    return `Refused: ${a.action} requires a recipient resolved by resolveSend() before the confirmation`;
  }
  // Built from the copy above, once, for every branch below. Calling formatRecipient(resolved)
  // at each receipt line would read the getter again, which is the same door the check above
  // closes — and send_token did exactly that until this was hoisted.
  const shown = isWrite(a.action) ? formatRecipient({ address: to, name: resolved.name }) : null;
  switch (a.action) {
    case "get_address":
      return wallet.getAddress() ?? "(wallet not initialized)";

    case "get_balance": {
      const bal = await wallet.getBalance();
      return `${formatMon(bal)} ${SYMBOL()}`;
    }

    case "get_token_balance": {
      const input = a.token ?? a.symbol ?? a.tokenAddress ?? "";
      if (isNativeToken(input)) {
        const bal = await wallet.getBalance();
        return `${formatMon(bal)} ${SYMBOL()}`;
      }
      const token = resolveToken(input);
      if (!token) {
        const known = listKnownTokenSymbols();
        const hint = known.length ? ` Known ${config.chain.network} symbols: ${known.join(", ")}.` : "";
        return `Unknown token "${String(input).trim()}" on ${config.chain.name}. Use a token contract address.${hint}`;
      }

      let { symbol, decimals, name } = token;
      if (!symbol || !Number.isInteger(decimals)) {
        const metadata = await wallet.getTokenMetadata(token.address);
        symbol ??= metadata.symbol;
        decimals ??= metadata.decimals;
        name ??= metadata.name;
      }
      if (!Number.isInteger(decimals)) {
        return `Refused: token ${token.address} does not expose decimals().`;
      }

      const bal = await wallet.getTokenBalance(token.address);
      const label = symbol || token.address;
      const detail = name && name !== label ? ` (${name})` : "";
      return `${formatTokenUnits(bal, decimals)} ${label}${detail}\n  token: ${token.address}`;
    }

    case "send_mon": {
      const value = parseMon(a.amountMon);
      const res = await wallet.send(to, value);
      if (res.dryRun) {
        return (
          `DRY RUN — would send ${a.amountMon} ${SYMBOL()} to ${shown}\n` +
          `  (est. fee ${formatMon(res.fee)} ${SYMBOL()}). Set PIMLICO_API_KEY in .env to broadcast for real.`
        );
      }
      if (res.hash) {
        const url = `${config.chain.explorerUrl}/tx/${res.hash}`;
        return (
          `Sent ${a.amountMon} ${SYMBOL()} to ${shown}\n` +
          `  tx:     ${res.hash}\n  ${url}\n` +
          `  userOp: ${res.userOpHash}`
        );
      }
      // Broadcast, but the receipt hasn't landed within the wait window.
      return (
        `Submitted ${a.amountMon} ${SYMBOL()} to ${shown} (gasless UserOp)\n` +
        `  userOp: ${res.userOpHash}\n` +
        `  (not confirmed on-chain yet — should land shortly; re-check /balance)`
      );
    }

    case "send_token": {
      // `to` is the address resolveSend() produced and the boundary above validated. Using
      // a.to here would re-read model output and, for an address-book name, hand the raw
      // alias to isAddress() — the guard would pass and the send would fail confusingly.
      const input = a.token ?? a.tokenSymbol ?? a.tokenAddress ?? "";
      if (!input) return "Refused: no token specified. Use a symbol (e.g. USDC) or contract address.";

      const token = resolveToken(input);
      if (!token) {
        const known = listKnownTokenSymbols();
        const hint = known.length ? ` Known ${config.chain.network} symbols: ${known.join(", ")}.` : "";
        return `Unknown token "${String(input).trim()}" on ${config.chain.name}. Use a token contract address.${hint}`;
      }

      const amountWei = parseTokenAmount(a.amount, token.decimals);
      if (amountWei === null) return `Refused: "${a.amount}" is not a valid token amount.`;

      const res = await wallet.sendToken(to, token.address, amountWei);
      const label = token.symbol || token.address;

      if (res.dryRun) {
        return (
          `DRY RUN — would send ${a.amount} ${label} to ${shown}\n` +
          `  token: ${token.address}\n` +
          `  (est. fee ${formatMon(res.fee)} ${SYMBOL()}). Set PIMLICO_API_KEY in .env to broadcast for real.`
        );
      }
      if (res.hash) {
        const url = `${config.chain.explorerUrl}/tx/${res.hash}`;
        return (
          `Sent ${a.amount} ${label} to ${shown}\n` +
          `  token:  ${token.address}\n` +
          `  tx:     ${res.hash}\n  ${url}\n` +
          `  userOp: ${res.userOpHash}`
        );
      }
      return (
        `Submitted ${a.amount} ${label} to ${shown} (gasless UserOp)\n` +
        `  token:  ${token.address}\n` +
        `  userOp: ${res.userOpHash}\n` +
        `  (not confirmed on-chain yet — should land shortly; re-check /balance)`
      );
    }

    default:
      return null; // caller falls back to a plain chat reply
  }
}
