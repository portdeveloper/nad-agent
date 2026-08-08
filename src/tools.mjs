/**
 * The wallet "tools" the agent can invoke, plus the NL->action interpreter.
 *
 * Design note: v0 uses a model-agnostic JSON-action protocol (works even on a
 * 360M dev model) rather than betting on any one model's native tool-calling.
 * On a big model (GPT_OSS_20B) you can swap this for QVAC's native tool calling
 * or the official @tetherto/wdk-mcp-toolkit MCP server — see README "Upgrade path".
 */

import { readFileSync } from "node:fs";
import { getAddress } from "ethers";
import * as wallet from "./wallet.mjs";
import { config } from "./config.mjs";
import { parseMon, formatMon, formatTokenUnits, parseTokenAmount, isAddress } from "./format.mjs";
import { listKnownTokenSymbols, resolveToken } from "./tokens.mjs";

// Address-book name resolution (issue #2): a send takes a raw 0x address or a
// name from a local JSON book. Monad has no name service yet, so a local file is
// the accepted v0. The name resolves to a checksummed address BEFORE the confirm
// step; a transfer can't be undone, so anything unknown, ambiguous or malformed
// is refused with a reason rather than guessed at.
function loadAddressBook() {
  let text;
  try {
    text = readFileSync(config.addressBookPath, "utf8");
  } catch {
    return {}; // no file: aliases unavailable, raw 0x addresses still work
  }
  const book = JSON.parse(text);
  if (book === null || typeof book !== "object" || Array.isArray(book)) {
    throw new Error("expected a JSON object of name -> address");
  }
  return book;
}

/**
 * Pure resolver: an input + an already-loaded book -> { ok, address, name } or
 * { ok:false, reason }. Names match case-insensitively; a raw address passes
 * through (name is null). No file IO, so it is easy to test in isolation.
 */
export function resolveInBook(input, book = {}) {
  const raw = String(input ?? "").trim();
  if (!raw) return { ok: false, reason: "no recipient given." };

  // Raw 0x address: canonicalize it. getAddress accepts all-lower/all-upper and
  // verifies the EIP-55 checksum on mixed case, so a mistyped address is caught
  // here instead of being broadcast to the wrong place.
  if (isAddress(raw)) {
    try {
      return { ok: true, address: getAddress(raw), name: null };
    } catch {
      return { ok: false, reason: `"${raw}" is not a valid address (checksum failed — check for a typo).` };
    }
  }

  // Otherwise it is an address-book name. The same name mapped to two different
  // addresses is ambiguous, not a coin toss.
  const lower = raw.toLowerCase();
  const matches = Object.entries(book).filter(([name]) => name.toLowerCase() === lower);
  if (matches.length === 0) {
    return { ok: false, reason: `"${raw}" is not a known name in the address book and is not a 0x address.` };
  }
  const distinct = new Set(matches.map(([, addr]) => String(addr).trim().toLowerCase()));
  if (distinct.size > 1) {
    return { ok: false, reason: `"${raw}" is ambiguous: the address book maps it to ${distinct.size} different addresses.` };
  }
  const [name, addr] = matches[0];
  try {
    return { ok: true, address: getAddress(String(addr).trim()), name };
  } catch {
    return { ok: false, reason: `the address book entry for "${name}" (${addr}) is not a valid address.` };
  }
}

/** Resolve a recipient against the on-disk address book (config.addressBookPath). */
export function resolveRecipient(input) {
  const raw = String(input ?? "").trim();
  // A raw address needs no book, so a broken book file never blocks a 0x send.
  if (isAddress(raw)) return resolveInBook(raw);
  let book;
  try {
    book = loadAddressBook();
  } catch (err) {
    return { ok: false, reason: `could not read the address book (${config.addressBookPath}): ${err.message}` };
  }
  return resolveInBook(raw, book);
}

export const ACTIONS = {
  get_address: { args: [], desc: "Show the agent's own wallet address." },
  get_balance: { args: [], desc: "Show the agent's native MON balance." },
  get_token_balance: {
    args: ["token"],
    desc: "Show an ERC-20 token balance by token symbol or contract address.",
  },
  send_mon: { args: ["to", "amountMon"], desc: "Send native MON to `to` (a 0x address or an address-book name), amount in MON as a string." },
  send_token: {
    args: ["token", "to", "amount"],
    desc: "Send an ERC-20 token to `to` (a 0x address or an address-book name). `token` is a symbol (e.g. USDC) or contract address. `amount` is a human-readable string.",
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

/** True if the action mutates chain state and should require confirmation. */
export function isWrite(action) {
  return action === "send_mon" || action === "send_token";
}

// The gas-mode suffix shown after a send preview.
function gasSuffix() {
  return config.gasMode === "dry-run"
    ? "  (DRY RUN — will be simulated)"
    : config.gasMode === "sponsored"
      ? "  (gasless)"
      : "  (you pay gas)";
}

// How the recipient reads in a preview or result. A resolved recipient (from
// resolveRecipient) is preferred so the address shown is the one that gets
// signed; without it we fall back to the raw target so a preview never throws.
function destLabel(rawTo, resolved) {
  if (resolved?.ok) return resolved.name ? `${resolved.name} (${resolved.address})` : resolved.address;
  return String(rawTo ?? "");
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
    case "send_mon":
      return `Send ${a.amountMon} ${SYMBOL()} -> ${destLabel(a.to, resolved)}` + gasSuffix();
    case "send_token": {
      const label = a.tokenSymbol || a.token || "token";
      return `Send ${a.amount} ${label} -> ${destLabel(a.to, resolved)}` + gasSuffix();
    }
    default:
      return "No on-chain action";
  }
}

/** Execute an action. Returns a printable string. Assumes wallet is initialized for chain ops. */
export async function runAction(a, resolved) {
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
      const r = resolved ?? resolveRecipient(a.to);
      if (!r.ok) return `Refused: ${r.reason}`;
      const value = parseMon(a.amountMon);
      const res = await wallet.send(r.address, value);
      const dest = r.name ? `${r.name} (${r.address})` : r.address;
      if (res.dryRun) {
        return (
          `DRY RUN — would send ${a.amountMon} ${SYMBOL()} to ${dest}\n` +
          `  (est. fee ${formatMon(res.fee)} ${SYMBOL()}). Set PIMLICO_API_KEY in .env to broadcast for real.`
        );
      }
      if (res.hash) {
        const url = `${config.chain.explorerUrl}/tx/${res.hash}`;
        return (
          `Sent ${a.amountMon} ${SYMBOL()} to ${dest}\n` +
          `  tx:     ${res.hash}\n  ${url}\n` +
          `  userOp: ${res.userOpHash}`
        );
      }
      // Broadcast, but the receipt hasn't landed within the wait window.
      return (
        `Submitted ${a.amountMon} ${SYMBOL()} to ${dest} (gasless UserOp)\n` +
        `  userOp: ${res.userOpHash}\n` +
        `  (not confirmed on-chain yet — should land shortly; re-check /balance)`
      );
    }

    case "send_token": {
      const r = resolved ?? resolveRecipient(a.to);
      if (!r.ok) return `Refused: ${r.reason}`;
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

      const res = await wallet.sendToken(r.address, token.address, amountWei);
      const label = token.symbol || token.address;
      const dest = r.name ? `${r.name} (${r.address})` : r.address;

      if (res.dryRun) {
        return (
          `DRY RUN — would send ${a.amount} ${label} to ${dest}\n` +
          `  token: ${token.address}\n` +
          `  (est. fee ${formatMon(res.fee)} ${SYMBOL()}). Set PIMLICO_API_KEY in .env to broadcast for real.`
        );
      }
      if (res.hash) {
        const url = `${config.chain.explorerUrl}/tx/${res.hash}`;
        return (
          `Sent ${a.amount} ${label} to ${dest}\n` +
          `  token:  ${token.address}\n` +
          `  tx:     ${res.hash}\n  ${url}\n` +
          `  userOp: ${res.userOpHash}`
        );
      }
      return (
        `Submitted ${a.amount} ${label} to ${dest} (gasless UserOp)\n` +
        `  token:  ${token.address}\n` +
        `  userOp: ${res.userOpHash}\n` +
        `  (not confirmed on-chain yet — should land shortly; re-check /balance)`
      );
    }

    default:
      return null; // caller falls back to a plain chat reply
  }
}
