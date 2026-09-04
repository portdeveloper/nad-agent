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
import { parseMon, formatMon, formatTokenUnits, parseTokenAmount, isAddress, toChecksumAddress } from "./format.mjs";
import { listKnownTokenSymbols, resolveToken } from "./tokens.mjs";
import { resolveRecipient, formatRecipient, safeEcho } from "./addressBook.mjs";
import { checkPolicy, checkSwapPolicy, describePolicy, describeSwapPolicy } from "./policy.mjs";
import {
  SWAP_DEADLINE_SECONDS,
  requireDex,
  resolveSwapToken,
  isWrapPair,
  quoteRoutes,
  applySlippage,
  buildSwapCalls,
} from "./swap.mjs";

export const ACTIONS = {
  get_address: { args: [], desc: "Show the agent's own wallet address." },
  get_balance: { args: [], desc: "Show the agent's native MON balance." },
  get_token_balance: {
    args: ["token"],
    desc: "Show an ERC-20 token balance by token symbol or contract address.",
  },
  get_nfts: {
    args: ["address"],
    desc: "Show the ERC-721 NFTs owned by the agent's wallet (or by the given 0x address, if provided).",
  },
  send_mon: { args: ["to", "amountMon"], desc: "Send native MON to `to` — a 0x address or an address-book name — amount in MON as a string." },
  send_token: {
    args: ["token", "to", "amount"],
    desc: "Send an ERC-20 token to `to` — a 0x address or an address-book name. `token` is a symbol (e.g. USDC) or contract address. `amount` is a human-readable string.",
  },
  account: {
    args: ["index"],
    desc: "List derived accounts (no args) or switch to account `index` (BIP-44).",
  },
  transfer_nft: {
    args: ["to", "contractAddress", "tokenId"],
    optionalArgs: ["fromAddress"],
    desc: "Send an ERC-721 NFT to `to` — a 0x address or an address-book name. `contractAddress` is the NFT contract address, `tokenId` the token id as a string. Sends from the agent's own wallet unless `fromAddress` is given.",
  },
  swap: {
    args: ["amountIn", "tokenIn", "tokenOut"],
    desc: "Swap tokens on the testnet DEX. `amountIn` is a string amount of `tokenIn`; tokens are symbols (MON, WMON, USDC, USDT, WETH) or 0x addresses.",
  },
  none: { args: [], desc: "The message is not an on-chain request; just reply in words." },
};

const SYMBOL = () => config.chain.symbol;
const isNativeToken = (token) => String(token ?? "").trim().toUpperCase() === SYMBOL();
const ADDRESS_RE = /\b0x[0-9a-fA-F]{40}\b/;
const looksLikeBalanceQuestion = (text) => /\b(balance|bal|holding|holdings)\b/i.test(text);
const looksLikeNftQuestion = (text) => {
  // Ownership language only — and never when the text is asking to move something,
  // so "send my NFT to alice" does not silently become a read.
  if (/\b(send|transfer|move)\b/i.test(text)) return false;
  return /\b(nfts?)\b/i.test(text) && /\b(my|i own|owned|holdings?|in my wallet)\b/i.test(text);
};

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
    .map(([name, { args, optionalArgs = [], desc }]) => {
      // Optional arguments belong in the signature the model reads — `desc` already tells it
      // to use them — but not in `args`, which hasRequiredArgs() treats as mandatory. Marking
      // them keeps the model from filling one in merely because it appears in the list.
      const shown = [...args, ...optionalArgs.map((x) => `${x}?`)];
      return `- ${name}(${shown.join(", ")}): ${desc}`;
    })
    .join("\n");
  const dex = config.chain.dex;
  const swapLine = dex
    ? `Swaps run on ${dex.name}. Known tokens: ${[config.chain.symbol, ...dex.tokens.map((t) => t.symbol)].join(", ")}. ` +
      `Example: {"action":"swap","amountIn":"0.1","tokenIn":"MON","tokenOut":"USDC"}.\n`
    : "";
  return (
    `You are nad-agent, a wallet assistant on ${config.chain.name}. You control a ` +
    `self-custodial smart account. When the user wants an on-chain action, respond ` +
    `with ONE line of JSON and nothing else, e.g. {"action":"send_mon","to":"0x...","amountMon":"0.5"}.\n` +
    `Available actions:\n${list}\n` +
    swapLine +
    `If it isn't an on-chain request, use {"action":"none"}. Never invent addresses.`
  );
}

function normalizeParsedAction(obj) {
  if (!obj?.action || !ACTIONS[obj.action]) return null;
  const token = obj.token ?? obj.symbol ?? obj.tokenAddress;
  if (obj.action === "get_balance" && token && !isNativeToken(token)) {
    return { action: "get_token_balance", token };
  }
  if (obj.action === "swap") {
    return {
      action: "swap",
      amountIn: String(obj.amountIn ?? obj.amount ?? ""),
      tokenIn: obj.tokenIn ?? obj.from,
      tokenOut: obj.tokenOut ?? obj.to,
    };
  }
  if (obj.action === "transfer_nft" && !obj.to && obj.toAddress) obj = { ...obj, to: obj.toAddress };
  return obj;
}

function hasRequiredArgs(action) {
  if (action.action === "account" || action.action === "get_nfts") return true;
  const aliases = { token: ["token", "symbol", "tokenAddress"], to: ["to", "toAddress"] };
  return (ACTIONS[action.action]?.args ?? []).every((key) => {
    const keys = aliases[key] ?? [key];
    return keys.some((candidate) =>
      action[candidate] !== undefined && action[candidate] !== null && String(action[candidate]).trim() !== ""
    );
  });
}

function extractJsonCandidates(text) {
  const source = String(text ?? "").replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "");
  const candidates = [];
  let unterminated = "";
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== "{") continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let j = i; j < source.length; j++) {
      const ch = source[j];
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') quoted = false;
        continue;
      }
      if (ch === '"') { quoted = true; continue; }
      if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        candidates.push(source.slice(i, j + 1));
        i = j;
        break;
      }
    }
    if (depth > 0) {
      unterminated = source.slice(i);
      break;
    }
  }
  return { source, candidates, unterminated };
}

/** Extract an action from a model response: JSON first, then a lenient fallback. */
export function parseAction(text) {
  const extracted = extractJsonCandidates(text);
  if (extracted.unterminated && /\"action\"\s*:/i.test(extracted.unterminated)) {
    return { action: "none" };
  }
  let sawAction = false;
  for (const candidate of extracted.candidates.reverse()) {
    try {
      const action = normalizeParsedAction(JSON.parse(candidate));
      if (!action) continue;
      sawAction = true;
      if (!hasRequiredArgs(action)) return { action: "none" };
      return action;
    } catch {
      /* try the next JSON object */
    }
  }
  if (sawAction || (extracted.source.includes("{") && /\"action\"\s*:/i.test(extracted.source))) {
    return { action: "none" };
  }
  const fallbackText = extracted.source;
  // Small models often emit `get_balance()` instead of JSON. Recognize READ-ONLY
  // action names in the text — but never auto-trigger a write (send needs real args).
  // Only accept the extracted token if it looks like a real identifier: a 0x address,
  // or a short alphanumeric symbol (<=20 chars). This prevents sensitive strings
  // embedded in model output from leaking into error messages.
  const sanitizeLenientToken = (raw) => {
    const t = raw.trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(t)) return t;          // valid address
    if (/^[a-zA-Z]{1,20}$/.test(t)) return t;              // short symbol
    return null;                                             // garbage — ignore
  };
  const tokenBalanceCall = fallbackText.match(/\bget_token_balance\s*\(\s*["']?([^"')\s,]+)["']?\s*\)/i);
  if (tokenBalanceCall) {
    const t = sanitizeLenientToken(tokenBalanceCall[1]);
    if (t) return { action: "get_token_balance", token: t };
  }
  const balanceWithTokenCall = fallbackText.match(/\bget_balance\s*\(\s*["']?([^"')\s,]+)["']?\s*\)/i);
  if (balanceWithTokenCall) {
    const t = sanitizeLenientToken(balanceWithTokenCall[1]);
    if (t) return isNativeToken(t) ? { action: "get_balance" } : { action: "get_token_balance", token: t };
  }

  const tokenBalancePhrase = parseTokenBalancePhrase(fallbackText);
  if (tokenBalancePhrase) return tokenBalancePhrase;

  if (looksLikeNftQuestion(fallbackText)) return { action: "get_nfts" };

  const swap = parseSwapPhrase(fallbackText);
  if (swap) return swap;

  for (const name of ["get_balance", "get_address", "get_nfts"]) {
    if (new RegExp(`\\b${name}\\b`).test(fallbackText)) return { action: name };
  }
  return { action: "none" };
}

/**
 * Deterministic parse of a swap written in plain English, e.g.
 * "swap 5 USDC for WMON" / "swap 0.1 MON to USDC".
 * Every argument comes from the user's own words; the confirmation gate still applies.
 * Sends are still not guessed from free text.
 */
export function parseSwapPhrase(text) {
  const token = "(0x[0-9a-fA-F]{40}|[A-Za-z][A-Za-z0-9]{1,11})";
  const re = new RegExp(
    `\\b(?:swap|trade|exchange|convert)\\s+([0-9]*\\.?[0-9]+)\\s+${token}\\s+(?:for|to|into|->|→)\\s+${token}\\b`,
    "i",
  );
  const m = String(text ?? "").match(re);
  if (!m) return null;
  return { action: "swap", amountIn: m[1], tokenIn: m[2], tokenOut: m[3] };
}

/**
 * Resolve a send's recipient ONCE, before anything is shown or signed.
 *
 * Callers refuse before prompting: asking someone to confirm a transfer that is already
 * going to be declined teaches them the prompt is a formality.
 */
export function resolveSend(a, { policy = null, sessionSpent = 0n } = {}) {
  if (!needsRecipient(a.action)) return { ok: true, recipient: null };
  // transfer_nft names its recipient `toAddress` in the model contract; `to` stays the
  // field for sends, so accept either (same alias rule as token/tokenAddress).
  const r = resolveRecipient(a.to ?? a.toAddress);
  if (!r.ok) return { ok: false, reason: r.reason };
  // The spend policy is checked here, on the resolved address, so every send
  // passes through it: the allowlist binds token transfers as well as native
  // sends, while the MON amount limits only apply to amounts actually
  // denominated in MON (a token amount arrives as null and skips them).
  // Swaps are not sends — they use checkSwapPolicy() instead.
  let value = null;
  if (a.action === "send_mon") {
    try {
      value = parseMon(a.amountMon);
    } catch {
      // safeEcho: the amount comes from model output or script args, and a refusal
      // must not hand raw bytes to the terminal — same rule as recipient refusals.
      return { ok: false, reason: `invalid amount: "${safeEcho(a.amountMon)}" is not a valid MON value` };
    }
    // parseEther happily returns negative and zero bigints; neither is a send.
    if (value <= 0n) {
      return { ok: false, reason: `invalid amount: "${safeEcho(a.amountMon)}" — a send must be greater than zero` };
    }
  }
  const verdict = checkPolicy(policy, { to: r.address, value, sessionSpent });
  if (!verdict.ok) return { ok: false, reason: `policy ${verdict.rule}: ${verdict.message}` };
  return { ok: true, recipient: r };
}

function tokenInput(a) {
  return a.token ?? a.tokenSymbol ?? a.tokenAddress ?? a.symbol ?? "";
}

function tokenCatalogStatus() {
  const known = listKnownTokenSymbols();
  if (!known.length) {
    return {
      hasEntries: false,
      hint: `No built-in token symbols are configured for ${config.chain.name}.`,
    };
  }
  return {
    hasEntries: true,
    hint: `Known ${config.chain.network} symbols: ${known.join(", ")}.`,
  };
}

function unknownTokenMessage(input) {
  const catalog = tokenCatalogStatus();
  if (!catalog.hasEntries) {
    return `${catalog.hint} Use a token contract address.`;
  }
  return `Unknown token "${safeEcho(input)}" on ${config.chain.name}. Use a token contract address. ${catalog.hint}`;
}

/**
 * Prepare an ERC-20 send before the confirmation prompt.
 *
 * The recipient and token metadata are resolved once here, and the parsed token amount is
 * returned with them so the caller can pass the exact prepared values into execution after
 * confirmation. Catalog tokens already carry metadata; raw token addresses must expose
 * decimals() through the wallet read path and may provide symbol()/name() metadata.
 */
export async function prepareTokenSend(
  a,
  { policy = null, sessionSpent = 0n, getMetadata = wallet.getTokenMetadata } = {},
) {
  if (a?.action !== "send_token") {
    return { ok: false, reason: "not a send_token action" };
  }

  const resolved = resolveSend(a, { policy, sessionSpent });
  if (!resolved.ok) return resolved;

  const input = tokenInput(a);
  if (!String(input).trim()) {
    return { ok: false, reason: "no token specified. Use a symbol (e.g. USDC) or contract address." };
  }

  let token;
  try {
    token = resolveToken(input);
  } catch (err) {
    const detail = err?.shortMessage || err?.message || "invalid token identifier";
    if (/checksum/i.test(detail)) {
      return { ok: false, reason: `invalid token address "${safeEcho(input)}" (checksum failed)` };
    }
    return { ok: false, reason: `invalid token "${safeEcho(input)}": ${safeEcho(detail)}` };
  }
  if (!token) {
    return { ok: false, reason: unknownTokenMessage(input) };
  }

  let prepared = token;
  if (!Number.isInteger(prepared.decimals) || !prepared.symbol) {
    let metadata;
    try {
      metadata = await getMetadata(token.address);
    } catch (err) {
      const detail = safeEcho(err?.shortMessage || err?.message || "unable to read token metadata");
      return { ok: false, reason: `unable to read metadata for token ${token.address}: ${detail}` };
    }
    prepared = { ...token, ...metadata, address: token.address };
  }

  if (!Number.isInteger(prepared.decimals)) {
    return { ok: false, reason: `token ${token.address} does not expose decimals().` };
  }
  if (typeof prepared.symbol !== "string" || !prepared.symbol.trim()) {
    prepared = { ...prepared, symbol: token.address };
  }

  const amountWei = parseTokenAmount(a.amount, prepared.decimals);
  if (amountWei === null) {
    return { ok: false, reason: `"${safeEcho(a.amount)}" is not a valid token amount.` };
  }

  return { ok: true, recipient: resolved.recipient, token: prepared, amountWei };
}

/** Writes that pay a third party and therefore need resolveSend(). Swap pays the agent itself. */
export function needsRecipient(action) {
  return action === "send_mon" || action === "send_token" || action === "transfer_nft";
}
/** True if the action mutates chain state and should require confirmation. */
export function isWrite(action) {
  return needsRecipient(action) || action === "swap";
}

/** True if a runAction result is a refusal. Refusals are returned as strings
 *  prefixed "Refused:" (see the returns throughout runAction), never thrown. */
export function isRefusal(out) {
  return String(out ?? "").startsWith("Refused:");
}

/** Parse an account index from model output or CLI input.
 *  Accepts: integer number, or decimal string that parses to an integer.
 *  Rejects: booleans, null, undefined, objects, floats with fractional parts,
 *  out-of-range values. Values > 0 that have no fractional part (e.g. 3.0,
 *  which is a float literal but represents an integer) are accepted. */
export function parseAccountIndex(raw) {
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < 0 || raw > 999) return null;
    return raw || 0; // normalize -0 to 0
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < 0 || n > 999) return null;
    return n || 0;
  }
  return null; // boolean, null, object, etc.
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
    case "account": {
      const i = parseAccountIndex(a.index);
      if (i !== null) {
        return `Switch to account #${i}`;
      }
      return "Read: list derived accounts";
    }
    case "get_nfts":
      return "Read: your ERC-721 NFTs";
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
    case "transfer_nft": {
      // Same recipient rule as the sends above: show what was resolved, never the raw model
      // output. isWrite() covers transfer_nft, so resolveSend() has already run.
      const contract = a.contractAddress ?? a.contract ?? "unknown contract";
      const dest = resolved?.ok ? formatRecipient(resolved) : "[recipient not resolved]";
      // safeEcho for the same reason the label and recipient get it: this line is what the
      // operator reads before approving, and an unsanitised value can reflow or overwrite
      // what follows. Trimmed as well, because runAction refuses padding but only after this
      // line has been shown and approved — the guard protects the wallet, not the reader, so
      // the reader is served a clean line here rather than a ragged one plus a late refusal.
      const from = a.fromAddress
        ? ` (from ${safeEcho(String(a.fromAddress).trim(), 42)})`
        : "";
      return `Send NFT #${a.tokenId} (${contract}) -> ${dest}${from}` +
        (config.gasMode === "dry-run" ? "  (DRY RUN — will be simulated)" : config.gasMode === "sponsored" ? "  (gasless)" : "  (you pay gas)");
    }
    case "swap":
      return `Swap ${a.amountIn} ${a.tokenIn} -> ${a.tokenOut}` + gasSuffix();
    default:
      return "No on-chain action";
  }
}

function sendGasLabel() {
  return config.gasMode === "sponsored" ? "gasless (paymaster covers fee)"
    : config.gasMode === "dry-run" ? "dry-run (simulated, nothing broadcast)"
    : "you pay gas in " + SYMBOL();
}

function gasSuffix() {
  return config.gasMode === "dry-run"
    ? "  (DRY RUN — will be simulated)"
    : config.gasMode === "sponsored"
      ? "  (gasless)"
      : "  (you pay gas)";
}
/**
 * Pre-flight a send for the confirmation block. Takes the ALREADY-RESOLVED
 * checksummed recipient (the caller resolves once, so an address-book name
 * from #42 can be mapped before this runs), reads the balance, and simulates
 * fee + post-send balance so the user sees the effect before approving.
 */
export async function previewSend(a, to, { policy = null, sessionSpent = 0n } = {}) {
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
  const gasLabel = sendGasLabel();
  return { to, amountMon: a.amountMon, symbol: SYMBOL(), value, fee, simulated,
           before, after, gasLabel, paysGas, insufficient, simError,
           policyNote: describePolicy(policy, { value, sessionSpent }) };
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
  if (p.policyNote) {
    lines.push(`Policy:   ${p.policyNote}`);
  }
  if (p.simError && !p.insufficient) {
    lines.push(`WARNING:  simulation failed, this send may revert (${p.simError}).`);
  }
  return lines.join("\n");
}

/**
 * Pre-flight an ERC-20 send using the already-prepared token and recipient.
 *
 * The balance belongs to the active wallet, not the recipient. The caller supplies the
 * prepared result from prepareTokenSend(), so metadata, decimals, amount parsing, and
 * recipient resolution cannot drift between the preview and the eventual send.
 */
export async function previewTokenSend(
  prepared,
  {
    getBalance = wallet.getTokenBalance,
    quoteSend = wallet.quoteTokenSend,
    simulateSend = wallet.simulateTokenSend,
    policy = null,
    sessionSpent = 0n,
  } = {},
) {
  if (!prepared?.ok || !prepared.token || !prepared.recipient?.address) {
    return { ok: false, reason: "token send must be prepared before preview" };
  }

  const { token, amountWei, recipient } = prepared;
  if (!Number.isInteger(token.decimals)) {
    return { ok: false, reason: `token ${token.address} does not expose decimals().` };
  }
  if (typeof token.symbol !== "string" || !token.symbol.trim()) {
    return { ok: false, reason: `token ${token.address} does not expose symbol().` };
  }

  const before = await getBalance(token.address);
  const after = before - amountWei;
  const symbol = safeEcho(token.symbol, 32);
  const name = token.name ? safeEcho(token.name, 64) : "";
  let fee = 0n;
  let feeQuoted = false;
  let quoteError = null;
  try {
    const q = await quoteSend(recipient.address, token.address, amountWei);
    fee = BigInt(q?.fee ?? 0);
    feeQuoted = true;
  } catch (err) {
    quoteError = safeEcho(err?.shortMessage || err?.message || "fee quote unavailable", 160);
  }

  let simulated = false;
  let simulationError = null;
  try {
    const result = await simulateSend(recipient.address, token.address, amountWei);
    simulated = result?.simulated !== false;
    if (!simulated) simulationError = "transfer simulation unavailable";
  } catch (err) {
    simulationError = safeEcho(err?.shortMessage || err?.message || "simulation failed", 160);
  }

  return {
    ok: true,
    to: recipient.address,
    tokenAddress: token.address,
    symbol,
    name,
    decimals: token.decimals,
    amount: formatTokenUnits(amountWei, token.decimals),
    amountWei,
    before,
    after,
    fee,
    feeQuoted,
    quoteError,
    simulated,
    simulationError,
    nativeSymbol: SYMBOL(),
    gasLabel: sendGasLabel(),
    insufficient: amountWei > before,
    policyNote: describePolicy(policy, { value: null, sessionSpent }),
  };
}

/** Render the token preview as the confirmation block shown before y/N. */
export function renderTokenSendPreview(p) {
  const tokenName = p.name && p.name !== p.symbol ? ` (${p.name})` : "";
  const recipientText = String(p.to ?? "");
  const addressMatch = recipientText.match(/^(0x[0-9a-fA-F]{40})(.*)$/);
  const displayedRecipient = addressMatch
    ? `${toChecksumAddress(addressMatch[1])}${addressMatch[2]}`
    : recipientText;
  const lines = [
    `Token:    ${p.symbol}${tokenName}`,
    `Contract: ${p.tokenAddress}`,
    `To:       ${displayedRecipient}`,
    `Amount:   ${p.amount} ${p.symbol}`,
    `Gas:      ${p.gasLabel}` + (p.feeQuoted && p.fee > 0n ? `  (~${formatMon(p.fee)} ${p.nativeSymbol})` : ""),
    `Fee quote:${p.feeQuoted
      ? " available (transfer fee quote succeeded)"
      : config.gasMode === "dry-run"
        ? " unavailable (dry-run has no bundler estimate)"
        : " unavailable"}`,
    `Simulation:${p.simulated ? " available (transfer call succeeded)" : " unavailable"}`,
    `Balance:  ${formatTokenUnits(p.before, p.decimals)} -> ${formatTokenUnits(p.after, p.decimals)} ${p.symbol}`,
  ];
  if (p.insufficient) {
    lines.push("WARNING:  token balance is below the amount — this send would revert.");
  }
  if (p.quoteError && !p.insufficient) {
    lines.push(`WARNING:  fee quote unavailable (${p.quoteError}).`);
  }
  if (p.simulationError && !p.insufficient) {
    lines.push(`WARNING:  simulation failed, this send may revert (${p.simulationError}).`);
  }
  if (p.policyNote) {
    lines.push(`Policy:   ${p.policyNote}`);
  }
  return lines.join("\n");
}

function gasLabel() {
  return config.gasMode === "sponsored" ? "gasless (paymaster covers fee)"
    : config.gasMode === "dry-run" ? "dry-run (simulated, nothing broadcast)"
    : "you pay gas in " + SYMBOL();
}

/**
 * Quote every liquid PuddleSwap path, auto-pick the best output (same as the
 * PuddleSwap UI), and lay out one confirm block. The quote is a live eth_call,
 * so numbers are real even in dry-run.
 * Returns { error } or { block, routes, tokenIn, tokenOut, amountInRaw, amountIn,
 *   nativeIn, nativeOut, needsApproval, slippage }.
 * lockBestSwap() freezes the best path after y — a silent re-quote at confirm
 * refuses if output fell below the min-out that was shown.
 */
export async function buildSwapPreview(a, { policy = null, sessionSpent = 0n } = {}) {
  let dex;
  try {
    dex = requireDex();
  } catch (err) {
    return { error: err.message };
  }

  let tokenIn;
  let tokenOut;
  try {
    [tokenIn, tokenOut] = await Promise.all([
      resolveSwapToken(a.tokenIn),
      resolveSwapToken(a.tokenOut),
    ]);
  } catch (err) {
    return { error: err.message };
  }

  if (checksumEq(tokenIn.address, tokenOut.address) && !!tokenIn.native === !!tokenOut.native) {
    return { error: `${tokenIn.symbol} and ${tokenOut.symbol} are the same token.` };
  }
  if (isWrapPair(tokenIn, tokenOut, dex)) {
    return { error: `${config.chain.symbol} <-> WMON is a wrap, not a swap. That action is not supported yet.` };
  }

  const amountInRaw = tokenIn.native
    ? (() => { try { const v = parseMon(a.amountIn); return v > 0n ? v : null; } catch { return null; } })()
    : parseTokenAmount(a.amountIn, tokenIn.decimals);
  if (amountInRaw === null) {
    return { error: `"${a.amountIn}" is not a valid ${tokenIn.symbol} amount.` };
  }

  const nativeIn = !!tokenIn.native;
  const nativeOut = !!tokenOut.native;
  const verdict = checkSwapPolicy(policy, {
    nativeIn,
    value: nativeIn ? amountInRaw : null,
    sessionSpent,
  });
  if (!verdict.ok) {
    return { error: `policy ${verdict.rule}: ${verdict.message}` };
  }

  let ranked;
  try {
    ranked = await quoteRoutes(tokenIn, tokenOut, amountInRaw);
  } catch (err) {
    return { error: err.message };
  }

  const slippage = config.slippagePercent;
  const owner = wallet.getAddress();
  if (!owner) return { error: "wallet is not initialized (set WDK_SEED in .env)." };

  let needsApproval = false;
  let allowanceLine = null;
  if (!nativeIn) {
    try {
      const allowance = await wallet.getAllowance(tokenIn.address, dex.router, owner);
      needsApproval = allowance < amountInRaw;
      allowanceLine = needsApproval
        ? `approval:     approve ${a.amountIn} ${tokenIn.symbol} to the router, batched in the same UserOp`
        : `approval:     already approved (allowance ${formatTokenUnits(allowance, tokenIn.decimals)} ${tokenIn.symbol})`;
    } catch {
      needsApproval = true;
      allowanceLine = `approval:     approve ${a.amountIn} ${tokenIn.symbol} to the router (allowance read failed)`;
    }
  }

  let balanceLine = null;
  let insufficient = false;
  try {
    const bal = nativeIn ? await wallet.getBalance() : await wallet.getTokenBalance(tokenIn.address, owner);
    insufficient = bal < amountInRaw;
    balanceLine = `balance:      ${formatTokenUnits(bal, tokenIn.decimals)} ${tokenIn.symbol}` +
      (insufficient ? "  — insufficient balance" : "");
  } catch {
    /* best-effort */
  }

  const best = ranked[0];
  const minOut = applySlippage(best.amountOut, slippage);
  if (minOut <= 0n) {
    return { error: "quoted output is too small to set a min-out bound." };
  }
  const shown = [{ ...best, minOut, index: 0 }];

  const lines = [
    `SWAP on ${dex.name}${gasSuffix()}`,
    `pay:          ${a.amountIn} ${tokenIn.symbol}`,
    `receive:      ~${formatTokenUnits(best.amountOut, tokenOut.decimals)} ${tokenOut.symbol}`,
    `min received: ${formatTokenUnits(minOut, tokenOut.decimals)} ${tokenOut.symbol}  (reverts below this)`,
    `slippage:     ${slippage}%`,
    `route:        ${best.label}` + (ranked.length > 1 ? `  (${ranked.length} paths quoted, best wins)` : ""),
    ...(allowanceLine ? [allowanceLine] : []),
    ...(balanceLine ? [balanceLine] : []),
    `deadline:     ${SWAP_DEADLINE_SECONDS / 60} minutes after confirm`,
    `router:       ${dex.router}`,
    `gas:          ${gasLabel()}`,
  ];
  const policyNote = describeSwapPolicy(policy, {
    nativeIn,
    value: nativeIn ? amountInRaw : 0n,
    sessionSpent,
  });
  if (policyNote) lines.push(`Policy:       ${policyNote}`);
  if (insufficient) {
    lines.push(`WARNING:      balance is below the amount — this swap would revert.`);
  }

  return {
    block: lines.join("\n"),
    routes: shown,
    tokenIn,
    tokenOut,
    amountInRaw,
    amountIn: a.amountIn,
    nativeIn,
    nativeOut,
    needsApproval,
    slippage,
    owner,
    dexName: dex.name,
  };
}

function checksumEq(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

/**
 * At confirm: re-quote (auto-best). Keep the shown min-out as a floor so the
 * fill cannot be worse than what was approved. If the fresh output is below
 * that floor, refuse — cancel and /swap again. If the re-quote RPC fails, sign
 * the snapshot that was shown.
 */
export function mergeFreshQuote(shown, fresh, slippage) {
  if (!shown) return { ok: false, error: "no route to lock." };
  if (!fresh) return { ok: true, quote: shown };
  const minOut = applySlippage(fresh.amountOut, slippage);
  if (minOut <= 0n) return { ok: false, error: "quoted output is too small to set a min-out bound." };
  if (fresh.amountOut < shown.minOut) {
    return {
      ok: false,
      error: "quote moved below the min-out you were shown. Cancel and /swap again.",
    };
  }
  const floor = shown.minOut > minOut ? shown.minOut : minOut;
  return { ok: true, quote: { ...fresh, minOut: floor, index: 0 } };
}

/**
 * Freeze the best route into the calls that will be signed. Re-quotes once at
 * confirm (Uniswap/CowSwap "fresh quote before sign"); does not keep ticking.
 */
export async function lockBestSwap(preview) {
  if (preview?.error) return preview;
  const shown = preview.routes?.[0];
  if (!shown) return { error: "no route to lock." };
  let fresh = null;
  try {
    const ranked = await quoteRoutes(preview.tokenIn, preview.tokenOut, preview.amountInRaw);
    fresh = ranked[0] ?? null;
  } catch {
    fresh = null;
  }
  const merged = mergeFreshQuote(shown, fresh, preview.slippage);
  if (!merged.ok) return { error: merged.error };
  return lockSwapRoute({ ...preview, routes: [merged.quote] }, 0);
}

/**
 * Freeze one ranked route into the calls that will be signed. After this, the
 * path + min-out do not change.
 */
export function lockSwapRoute(preview, routeIndex = 0) {
  if (preview?.error) return preview;
  const quote = preview.routes?.[routeIndex];
  if (!quote) return { error: `route ${routeIndex + 1} is not available.` };
  const calls = buildSwapCalls({
    path: quote.path,
    amountInRaw: preview.amountInRaw,
    minAmountOutRaw: quote.minOut,
    recipient: preview.owner,
    nativeIn: preview.nativeIn,
    nativeOut: preview.nativeOut,
    needsApproval: preview.needsApproval,
  });
  return { ...preview, quote, calls, routeIndex };
}
/** Execute an action. Returns a printable string. Assumes wallet is initialized for chain ops. */
export async function runAction(a, resolved, opts = {}) {
  const preparedToken = opts.preparedToken ?? null;
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
  if (needsRecipient(a.action) && (resolved?.ok !== true || !isAddress(to) || to !== to.trim())) {
    return `Refused: ${a.action} requires a recipient resolved by resolveSend() before the confirmation`;
  }
  // Built from the copy above, once, for every branch below. Calling formatRecipient(resolved)
  // at each receipt line would read the getter again, which is the same door the check above
  // closes — and send_token did exactly that until this was hoisted.
  const shown = needsRecipient(a.action) ? formatRecipient({ address: to, name: resolved.name }) : null;
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
        return unknownTokenMessage(input);
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

    case "account": {
      const hasIndex = a.index !== undefined && a.index !== null && a.index !== "";
      if (hasIndex) {
        const i = parseAccountIndex(a.index);
        if (i === null) return `Refused: "${safeEcho(a.index)}" is not a valid account index.`;
        const newAddr = await wallet.switchAccount(i);
        return `Switched to account #${i}\n  address: ${newAddr}`;
      }
      const accounts = await wallet.listAccounts(5);
      const cur = wallet.getActiveAccountIndex();
      const lines = accounts.map((acc) =>
        `  ${acc.index === cur ? "→ " : "  "}#${acc.index}  ${acc.address}`
      );
      return `Derived accounts (active: #${cur}):\n${lines.join("\n")}`;
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

    case "get_nfts": {
      const owner = a.address ?? a.owner;
      if (owner && !isAddress(owner)) {
        return `Refused: "${String(owner).trim()}" is not a valid address.`;
      }
      const { tokens, skipped, truncated } = await wallet.getNfts(owner);
      // Notes, not silence: an empty list caused by unusable rows must not read as "you own
      // nothing", and a capped list must not read as the whole wallet.
      const notes = [];
      if (skipped) {
        notes.push(`(${skipped} entr${skipped === 1 ? "y" : "ies"} from the indexer could not be read and ${skipped === 1 ? "was" : "were"} skipped)`);
      }
      if (truncated) {
        notes.push("(list is truncated: this wallet holds more than one page, only the first is shown)");
      }
      if (!tokens.length) {
        return ["No ERC-721 NFTs found.", ...notes].join("\n");
      }
      return [
        ...tokens.map((n) => `${n.name ?? `#${n.tokenId}`} (tokenId ${n.tokenId})\n  contract: ${n.contract}`),
        ...notes,
      ].join("\n");
    }

    case "transfer_nft": {
      // `to` is the address resolveSend() produced and the boundary above validated — same
      // rule as send_mon/send_token. `contractAddress`/`tokenId` come from model output.
      const contract = a.contractAddress ?? a.contract ?? "";
      if (!contract) return "Refused: no NFT contract address given.";
      if (a.tokenId === undefined || a.tokenId === null || String(a.tokenId).trim() === "") {
        return "Refused: no tokenId given.";
      }
      // `fromAddress` is optional — it only matters when the agent transfers an NFT it holds
      // an approval on rather than one it owns. But it is model output like `contract` and
      // `tokenId` above, and it was the one field on this path reaching ethers unchecked: a
      // garbage value came back as a raw `invalid address (argument="address"…)` throw from
      // inside the wallet instead of the `Refused:` line every other rejection here produces.
      // An empty string did the same, because "" is only falsy at the call site — it still
      // reaches checksumAddress. Refuse before the wallet is touched, like the two above.
      // Same rule the recipient above follows: padding is refused rather than trimmed,
      // because isAddress() trims internally, so " 0x… " would pass the check and then reach
      // the confirmation line ragged. Whatever is validated here is also what gets passed on,
      // rather than re-reading a.fromAddress — an array or an object stringifies to a valid
      // address for the check and travels onward as itself otherwise.
      let fromAddress = a.fromAddress;
      if (fromAddress !== undefined && fromAddress !== null) {
        fromAddress = String(fromAddress);
        if (fromAddress.trim() === "") {
          return "Refused: fromAddress was given but empty — omit it to send from your own wallet.";
        }
        if (!isAddress(fromAddress) || fromAddress !== fromAddress.trim()) {
          return `Refused: "${safeEcho(fromAddress)}" is not a valid fromAddress.`;
        }
      }
      const res = await wallet.transferNft(to, contract, String(a.tokenId), fromAddress);
      const label = `#${a.tokenId} (${contract})`;

      if (res.dryRun) {
        return (
          `DRY RUN — would send NFT ${label} to ${shown}\n` +
          `  (est. fee ${formatMon(res.fee)} ${SYMBOL()}). Set PIMLICO_API_KEY in .env to broadcast for real.`
        );
      }
      if (res.hash) {
        const url = `${config.chain.explorerUrl}/tx/${res.hash}`;
        return (
          `Sent NFT ${label} to ${shown}\n` +
          `  tx:     ${res.hash}\n  ${url}\n` +
          `  userOp: ${res.userOpHash}`
        );
      }
      return (
        `Submitted NFT ${label} to ${shown} (gasless UserOp)\n` +
        `  userOp: ${res.userOpHash}\n` +
        `  (not confirmed on-chain yet — should land shortly; re-check your NFTs)`
      );
    }

    case "send_token": {
      // Token resolution, metadata lookup, amount parsing, and recipient resolution all happen
      // before the confirmation prompt. Requiring that prepared object here makes the address,
      // decimals, and exact uint amount approved by the operator the same values we execute.
      if (!preparedToken?.ok || preparedToken.recipient?.address !== to) {
        return "Refused: send_token requires the prepared token values from the confirmation flow";
      }

      const token = preparedToken.token;
      const amountWei = preparedToken.amountWei;
      if (!token?.address || !Number.isInteger(token.decimals) || typeof amountWei !== "bigint" || amountWei <= 0n) {
        return "Refused: send_token has invalid prepared token values";
      }
      const res = await wallet.sendToken(to, token.address, amountWei);
      const label = safeEcho(token.symbol || token.address, 32);
      const displayAmount = formatTokenUnits(amountWei, token.decimals);

      if (res.dryRun) {
        return (
          `DRY RUN — would send ${displayAmount} ${label} to ${shown}\n` +
          `  token: ${token.address}\n` +
          `  (est. fee ${formatMon(res.fee)} ${SYMBOL()}). Set PIMLICO_API_KEY in .env to broadcast for real.`
        );
      }
      if (res.hash) {
        const url = `${config.chain.explorerUrl}/tx/${res.hash}`;
        return (
          `Sent ${displayAmount} ${label} to ${shown}\n` +
          `  token:  ${token.address}\n` +
          `  tx:     ${res.hash}\n  ${url}\n` +
          `  userOp: ${res.userOpHash}`
        );
      }
      return (
        `Submitted ${displayAmount} ${label} to ${shown} (gasless UserOp)\n` +
        `  token:  ${token.address}\n` +
        `  userOp: ${res.userOpHash}\n` +
        `  (not confirmed on-chain yet — should land shortly; re-check /balance)`
      );
    }

    case "swap": {
      // cli.mjs (or smoke) already built and locked the preview the operator saw.
      // Re-quoting here would risk sending a min-out / path they never approved.
      let preview = opts.preview;
      if (!preview || preview.error || !preview.calls) {
        const built = await buildSwapPreview(a);
        if (built.error) return `Refused: ${built.error}`;
        preview = lockSwapRoute(built, 0);
        if (preview.error) return `Refused: ${preview.error}`;
      }

      const { quote, tokenIn, tokenOut, amountIn, slippage, dexName } = preview;
      const inAmount = `${amountIn} ${tokenIn.symbol}`;
      const minOut = `${formatTokenUnits(quote.minOut, tokenOut.decimals)} ${tokenOut.symbol}`;
      const expected = `${formatTokenUnits(quote.amountOut, tokenOut.decimals)} ${tokenOut.symbol}`;

      const res = await wallet.sendCalls(preview.calls);
      if (res.dryRun) {
        return (
          `DRY RUN — would swap ${inAmount} for ~${expected} on ${dexName}\n` +
          `  route:   ${quote.label}\n` +
          `  min out: ${minOut} (${slippage}% slippage)\n` +
          `  calls:   ${res.calls.length} in one UserOp${preview.needsApproval ? " (approve + swap)" : " (swap)"}\n` +
          `  (est. fee ${formatMon(res.fee)} ${SYMBOL()}). Set PIMLICO_API_KEY in .env to broadcast for real.`
        );
      }
      if (res.hash) {
        return (
          `Swapped ${inAmount} for ~${expected} on ${dexName}\n` +
          `  route:   ${quote.label}\n` +
          `  min out: ${minOut}\n` +
          `  tx:      ${res.hash}\n  ${config.chain.explorerUrl}/tx/${res.hash}\n` +
          `  userOp:  ${res.userOpHash}`
        );
      }
      return (
        `Submitted swap ${inAmount} -> ${tokenOut.symbol} (gasless UserOp)\n` +
        `  route:  ${quote.label}\n` +
        `  userOp: ${res.userOpHash}\n` +
        `  (not confirmed on-chain yet — should land shortly)`
      );
    }

    default:
      return null; // caller falls back to a plain chat reply
  }
}
