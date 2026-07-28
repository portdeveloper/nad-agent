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
import { parseMon, formatMon, parseAmount, formatAmount, isAddress } from "./format.mjs";

export const ACTIONS = {
  get_address: { args: [], desc: "Show the agent's own wallet address." },
  get_balance: { args: [], desc: "Show the agent's native MON balance." },
  send_mon: { args: ["to", "amountMon"], desc: "Send native MON to an address `to`, amount in MON as a string." },
  swap: {
    args: ["amountIn", "tokenIn", "tokenOut"],
    desc: "Swap tokens on the DEX. `amountIn` is a string amount of `tokenIn`; tokens are symbols (MON, WMON, USDC, USDT) or 0x addresses.",
  },
  none: { args: [], desc: "The message is not an on-chain request; just reply in words." },
};

const SYMBOL = () => config.chain.symbol;

/** Build the system prompt describing the tool protocol. */
export function systemPrompt() {
  const list = Object.entries(ACTIONS)
    .map(([name, { args, desc }]) => `- ${name}(${args.join(", ")}): ${desc}`)
    .join("\n");
  const dex = config.chain.dex;
  const swapLine = dex
    ? `Swaps run on ${dex.name}. Known tokens: ${[config.chain.symbol, ...dex.tokens.map((t) => t.symbol)].join(", ")}. ` +
      `Example: {"action":"swap","amountIn":"5","tokenIn":"USDC","tokenOut":"WMON"}.\n`
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
  // "swap 5 USDC for WMON" spelled out in words. Safe to accept without JSON
  // because the amount and both tokens are read from the text, never guessed,
  // and the write still goes through the confirmation prompt.
  const swap = parseSwapPhrase(text);
  if (swap) return swap;
  // Small models often emit `get_balance()` instead of JSON. Recognize a READ-ONLY
  // action name in the text — but never auto-trigger a write (send needs real args).
  for (const name of ["get_balance", "get_address"]) {
    if (new RegExp(`\\b${name}\\b`).test(text)) return { action: name };
  }
  return { action: "none" };
}

/**
 * Deterministic parse of a swap request written in plain English, e.g.
 *   "swap 5 USDC for WMON"      "swap 0.1 MON to USDC"
 *   "trade 2.5 usdc into 0xabc…"  "swap 5 USDC -> USDT"
 * Returns a swap action or null. Every argument comes from the user's own words,
 * so nothing is invented: a 360M model that cannot emit clean JSON still gets a
 * usable swap, and the confirmation gate in cli.mjs still applies.
 */
export function parseSwapPhrase(text) {
  const token = "(0x[0-9a-fA-F]{40}|[A-Za-z][A-Za-z0-9]{1,11})";
  const re = new RegExp(
    `\\b(?:swap|trade|exchange|convert)\\s+([0-9]*\\.?[0-9]+)\\s+${token}\\s+(?:for|to|into|->|→)\\s+${token}\\b`,
    "i"
  );
  const m = String(text ?? "").match(re);
  if (!m) return null;
  return { action: "swap", amountIn: m[1], tokenIn: m[2], tokenOut: m[3] };
}

/** True if the action mutates chain state and should require confirmation. */
export function isWrite(action) {
  return action === "send_mon" || action === "swap";
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
    case "swap":
      return `Swap ${a.amountIn} ${a.tokenIn} -> ${a.tokenOut}` + gasSuffix();
    default:
      return "No on-chain action";
  }
}

function gasSuffix() {
  return config.gasMode === "dry-run"
    ? "  (DRY RUN — will be simulated)"
    : config.gasMode === "sponsored"
      ? "  (gasless)"
      : "  (you pay gas)";
}

/**
 * Quote a swap and lay out everything the user needs before approving it: the
 * route, the quoted output, the min-out floor and the slippage that produced it.
 * The quote is a real eth_call against the router, so the numbers are live even
 * in dry-run mode with no key and no funds.
 *
 * Returns { block, calls, quote } to confirm, or { error } to refuse.
 */
export async function buildSwapPreview(a) {
  const dex = config.chain.dex;
  if (!dex) return { error: `swaps are not configured for ${config.chain.name} (testnet only for now).` };

  let tokenIn, tokenOut;
  try {
    [tokenIn, tokenOut] = await Promise.all([wallet.resolveToken(a.tokenIn), wallet.resolveToken(a.tokenOut)]);
  } catch (err) {
    return { error: err.message };
  }
  if (tokenIn.address === tokenOut.address) {
    // Same underlying token. MON <-> WMON is a wrap/unwrap, not a swap; routing
    // it through a hop pool would round-trip the pair and burn fees for nothing.
    return tokenIn.native !== tokenOut.native
      ? { error: `${config.chain.symbol} <-> WMON is a wrap, not a swap. That action is not supported yet.` }
      : { error: `${tokenIn.symbol} and ${tokenOut.symbol} are the same token.` };
  }

  let amountInRaw;
  try {
    amountInRaw = parseAmount(a.amountIn, tokenIn.decimals);
    if (amountInRaw <= 0n) return { error: `amount must be positive, got "${a.amountIn}".` };
  } catch {
    return { error: `"${a.amountIn}" is not a valid ${tokenIn.symbol} amount.` };
  }

  let quote;
  try {
    quote = await wallet.quoteSwap(tokenIn, tokenOut, amountInRaw);
  } catch (err) {
    return { error: err.message };
  }

  const slippage = config.slippagePercent;
  const minOut = wallet.applySlippage(quote.amountOut, slippage);
  if (minOut <= 0n) return { error: "quoted output is too small to set a min-out bound." };

  // The swap sends the output to the agent's own account, so the account has to
  // exist before the calls can be encoded.
  const owner = wallet.getAddress();
  if (!owner) return { error: "wallet is not initialized (set WDK_SEED in .env)." };

  const symbolOf = (addr) => {
    const hit = dex.tokens.find((t) => t.address.toLowerCase() === addr.toLowerCase());
    return hit ? hit.symbol : `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  };
  const route = quote.path.map(symbolOf).join(" -> ");

  // Native MON in/out is the wrapped token in the path; the router handles the
  // wrap, and a native-in swap needs no approval (the amount rides as msg.value).
  const nativeIn = !!tokenIn.native;
  const nativeOut = !!tokenOut.native;

  let needsApproval = false;
  let allowanceLine = null;
  if (!nativeIn) {
    try {
      const allowance = await wallet.getAllowance(tokenIn.address, owner);
      needsApproval = allowance < amountInRaw;
      allowanceLine = needsApproval
        ? `approval:      approve ${a.amountIn} ${tokenIn.symbol} to the router, batched in the same UserOp`
        : `approval:      already approved (allowance ${formatAmount(allowance, tokenIn.decimals)} ${tokenIn.symbol})`;
    } catch {
      // Allowance read failed: assume an approve is needed. A redundant approve
      // is harmless, a missing one reverts the swap.
      needsApproval = true;
      allowanceLine = `approval:      approve ${a.amountIn} ${tokenIn.symbol} to the router (allowance read failed)`;
    }
  }

  // Balance check is advisory: it warns, it does not block, since the user may
  // be funding the account between the confirm and the send.
  let balanceLine = null;
  try {
    const bal = nativeIn ? await wallet.getBalance() : await wallet.getTokenBalance(tokenIn.address, owner);
    const short = bal < amountInRaw ? "  — insufficient balance" : "";
    balanceLine = `balance:       ${formatAmount(bal, tokenIn.decimals)} ${tokenIn.symbol}${short}`;
  } catch {
    /* best-effort */
  }

  const lines = [
    `SWAP on ${dex.name}${gasSuffix()}`,
    `pay:           ${a.amountIn} ${tokenIn.symbol}`,
    `receive:       ~${formatAmount(quote.amountOut, tokenOut.decimals)} ${tokenOut.symbol}  (quoted now)`,
    `min received:  ${formatAmount(minOut, tokenOut.decimals)} ${tokenOut.symbol}  (reverts below this)`,
    `slippage:      ${slippage}%`,
    `route:         ${route}`,
    ...(allowanceLine ? [allowanceLine] : []),
    ...(balanceLine ? [balanceLine] : []),
    `deadline:      ${wallet.SWAP_DEADLINE_SECONDS / 60} minutes from now`,
    `router:        ${dex.router}`,
  ];

  const calls = wallet.buildSwapCalls({
    path: quote.path,
    amountInRaw,
    minAmountOutRaw: minOut,
    recipient: owner,
    nativeIn,
    nativeOut,
    needsApproval,
  });

  return {
    block: lines.join("\n"),
    calls,
    quote: { ...quote, minOut, slippage, tokenIn, tokenOut, route, needsApproval },
  };
}

/** Execute an action. Returns a printable string. Assumes wallet is initialized for chain ops. */
export async function runAction(a, opts = {}) {
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

    case "swap": {
      // cli.mjs already built the preview to show in the confirmation prompt;
      // reuse those exact calls so the user approves the numbers that execute.
      // Re-quoting here would risk sending a min-out the user never saw.
      const preview = opts.preview ?? (await buildSwapPreview(a));
      if (preview.error) return `Refused: ${preview.error}`;

      const { quote } = preview;
      const inAmount = `${a.amountIn} ${quote.tokenIn.symbol}`;
      const minOut = `${formatAmount(quote.minOut, quote.tokenOut.decimals)} ${quote.tokenOut.symbol}`;
      const expected = `${formatAmount(quote.amountOut, quote.tokenOut.decimals)} ${quote.tokenOut.symbol}`;
      const dexName = config.chain.dex.name;

      const res = await wallet.sendSwap(preview.calls);
      if (res.dryRun) {
        return (
          `DRY RUN — would swap ${inAmount} for ~${expected} on ${dexName}\n` +
          `  route:   ${quote.route}\n` +
          `  min out: ${minOut} (${quote.slippage}% slippage)\n` +
          `  calls:   ${res.calls.length} in one UserOp${quote.needsApproval ? " (approve + swap)" : " (swap)"}\n` +
          `  (est. fee ${formatMon(res.fee)} ${SYMBOL()}). Set PIMLICO_API_KEY in .env to broadcast for real.`
        );
      }
      if (res.hash) {
        return (
          `Swapped ${inAmount} for ~${expected} on ${dexName}\n` +
          `  route:  ${quote.route}\n` +
          `  min out:${minOut}\n` +
          `  tx:     ${res.hash}\n  ${config.chain.explorerUrl}/tx/${res.hash}\n` +
          `  userOp: ${res.userOpHash}`
        );
      }
      return (
        `Submitted swap ${inAmount} -> ${quote.tokenOut.symbol} (gasless UserOp)\n` +
        `  userOp: ${res.userOpHash}\n` +
        `  (not confirmed on-chain yet — should land shortly)`
      );
    }

    default:
      return null; // caller falls back to a plain chat reply
  }
}
