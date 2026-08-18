/**
 * PuddleSwap quote + calldata — the on-chain half of the `swap` action.
 *
 * PuddleSwap is portdeveloper's Uniswap-V2 DEX on Monad testnet
 * (https://github.com/portdeveloper/puddleswap). Quotes are plain `eth_call`s
 * to the router: no API server, no key. Star routing matches the PuddleSwap
 * app (`web/src/lib/routing.ts`): the direct pair, then one- and two-hop paths
 * through the core tokens (USDC, USDT, WMON). Every path that has liquidity is
 * kept and ranked by output so the operator can pick a route; we never silently
 * replace the path they confirmed.
 */

import { Contract, Interface, JsonRpcProvider, getAddress as checksum } from "ethers";
import { config } from "./config.mjs";
import { isAddress } from "./format.mjs";
import { resolveToken } from "./tokens.mjs";
import * as wallet from "./wallet.mjs";

const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
];

/** How long the router will honour a swap after the quote, in seconds. */
export const SWAP_DEADLINE_SECONDS = 10 * 60;

/** How many ranked routes to show in the confirm block. */
export const MAX_DISPLAY_ROUTES = 3;

let provider = null;

function readProvider() {
  if (!provider) {
    provider = new JsonRpcProvider(config.chain.rpcUrl, config.chain.chainId, { staticNetwork: true });
  }
  return provider;
}

export function requireDex() {
  const dex = config.chain.dex;
  if (!dex) {
    throw new Error(`No DEX is configured for ${config.chain.name}. Swaps are testnet-only for now.`);
  }
  return dex;
}

function coreAddresses(dex) {
  return dex.tokens.map((t) => checksum(t.address));
}

/**
 * Candidate paths A→B: direct, then one hop through each core, then two hops
 * through distinct cores. Same construction as PuddleSwap's `buildCandidateRoutes`.
 */
export function buildCandidatePaths(tokenIn, tokenOut, cores) {
  const a = checksum(tokenIn);
  const b = checksum(tokenOut);
  const hubs = cores.map((c) => checksum(c));
  const routes = [[a, b]];

  for (const core of hubs) {
    if (core !== a && core !== b) routes.push([a, core, b]);
  }
  for (const coreA of hubs) {
    for (const coreB of hubs) {
      if (coreA === coreB) continue;
      if (coreA === a || coreA === b || coreB === a || coreB === b) continue;
      routes.push([a, coreA, coreB, b]);
    }
  }

  const seen = new Set();
  const out = [];
  for (const path of routes) {
    let adjacentDup = false;
    for (let i = 1; i < path.length; i++) {
      if (path[i] === path[i - 1]) {
        adjacentDup = true;
        break;
      }
    }
    if (adjacentDup) continue;
    const key = path.join("-");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

/**
 * Minimum acceptable output at `slippagePercent`. Percent → basis points with
 * Math.floor, then integer bigint math — same as the PuddleSwap UI.
 */
export function applySlippage(amountOut, slippagePercent) {
  const bps = BigInt(Math.floor(Number(slippagePercent) * 100));
  return amountOut - (amountOut * bps) / 10_000n;
}

/** True when the pair is a wrap/unwrap (MON ↔ WMON), not a swap. */
export function isWrapPair(tokenIn, tokenOut, dex = config.chain.dex) {
  if (!dex || !tokenIn || !tokenOut) return false;
  const wrap = checksum(dex.wrappedNative);
  const official = dex.canonicalWrappedNative ? checksum(dex.canonicalWrappedNative) : null;
  const wraps = new Set([wrap, ...(official ? [official] : [])]);
  const inIsWrap = !tokenIn.native && wraps.has(checksum(tokenIn.address));
  const outIsWrap = !tokenOut.native && wraps.has(checksum(tokenOut.address));
  return (tokenIn.native && outIsWrap) || (tokenOut.native && inIsWrap);
}

/**
 * Resolve a user-named token for a swap. Dex symbols (WMON/USDC/USDT) win so
 * "WMON" hits PuddleSwap's wrap (where the pools are), not the canonical
 * testnet WMON used for balance reads.
 */
export async function resolveSwapToken(nameOrAddress) {
  const dex = requireDex();
  const input = String(nameOrAddress ?? "").trim();
  if (!input) throw new Error("No token given.");

  if (input.toUpperCase() === config.chain.symbol) {
    return {
      symbol: config.chain.symbol,
      address: checksum(dex.wrappedNative),
      decimals: 18,
      native: true,
    };
  }

  const bySymbol = dex.tokens.find((t) => t.symbol.toUpperCase() === input.toUpperCase());
  if (bySymbol) {
    return { ...bySymbol, address: checksum(bySymbol.address), native: false };
  }

  const catalog = resolveToken(input);
  if (catalog?.source === "catalog" && Number.isInteger(catalog.decimals)) {
    return {
      symbol: catalog.symbol,
      address: catalog.address,
      decimals: catalog.decimals,
      native: false,
    };
  }

  if (!isAddress(input)) {
    const known = [config.chain.symbol, ...dex.tokens.map((t) => t.symbol)].join(", ");
    throw new Error(`Unknown token "${input}". Known: ${known}. Or pass a 0x token address.`);
  }

  const address = checksum(input);
  if (address === checksum(dex.wrappedNative)) {
    return { symbol: "WMON", address, decimals: 18, native: false };
  }
  const meta = await wallet.getTokenMetadata(address);
  if (!Number.isInteger(meta.decimals)) {
    throw new Error(`Token ${address} does not expose decimals().`);
  }
  return {
    symbol: meta.symbol || `${address.slice(0, 6)}…${address.slice(-4)}`,
    address,
    decimals: meta.decimals,
    native: false,
  };
}

function symbolOf(addr, { tokenIn, tokenOut, nativeIn, nativeOut, dex }) {
  const a = checksum(addr);
  if (nativeIn && a === checksum(tokenIn.address)) return tokenIn.symbol;
  if (nativeOut && a === checksum(tokenOut.address)) return tokenOut.symbol;
  const hit = dex.tokens.find((t) => checksum(t.address) === a);
  if (hit) return hit.symbol;
  if (tokenIn.address && checksum(tokenIn.address) === a) return tokenIn.symbol;
  if (tokenOut.address && checksum(tokenOut.address) === a) return tokenOut.symbol;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function labelPath(path, ctx) {
  return path.map((addr) => symbolOf(addr, ctx)).join(" -> ");
}

/**
 * Ask the router for getAmountsOut on every candidate path. Paths with no pool
 * revert and are skipped. Ranked best-output-first. Pure eth_call — works in
 * dry-run with no key and no funds.
 */
export async function quoteRoutes(tokenIn, tokenOut, amountInRaw) {
  const dex = requireDex();
  const router = new Contract(checksum(dex.router), ROUTER_ABI, readProvider());
  const paths = buildCandidatePaths(tokenIn.address, tokenOut.address, coreAddresses(dex));
  const ctx = {
    tokenIn,
    tokenOut,
    nativeIn: !!tokenIn.native,
    nativeOut: !!tokenOut.native,
    dex,
  };

  const results = await Promise.all(
    paths.map(async (path) => {
      try {
        const amounts = await router.getAmountsOut(amountInRaw, path);
        const amountOut = BigInt(amounts[amounts.length - 1]);
        if (amountOut <= 0n) return null;
        return {
          path,
          amountOut,
          hops: path.length - 1,
          label: labelPath(path, ctx),
        };
      } catch {
        return null;
      }
    }),
  );

  const ranked = results
    .filter(Boolean)
    .sort((x, y) => (x.amountOut < y.amountOut ? 1 : x.amountOut > y.amountOut ? -1 : 0));
  if (ranked.length === 0) {
    throw new Error(`No ${dex.name} route with liquidity for ${tokenIn.symbol} -> ${tokenOut.symbol}.`);
  }
  return ranked;
}

/**
 * Build the WDK calls for one chosen route: an exact-amount ERC-20 approve
 * when the router allowance is short, then the matching swapExact* function.
 * WDK batches an array into ONE UserOperation, so approve + swap land atomically.
 */
export function buildSwapCalls({
  path,
  amountInRaw,
  minAmountOutRaw,
  recipient,
  nativeIn,
  nativeOut,
  needsApproval,
}) {
  const dex = requireDex();
  const router = checksum(dex.router);
  const routerIface = new Interface(ROUTER_ABI);
  const erc20Iface = new Interface([
    "function approve(address spender, uint256 amount) returns (bool)",
  ]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + SWAP_DEADLINE_SECONDS);
  const calls = [];

  if (needsApproval && !nativeIn) {
    calls.push({
      to: checksum(path[0]),
      value: 0n,
      data: erc20Iface.encodeFunctionData("approve", [router, amountInRaw]),
    });
  }

  if (nativeIn) {
    calls.push({
      to: router,
      value: amountInRaw,
      data: routerIface.encodeFunctionData("swapExactETHForTokens", [
        minAmountOutRaw,
        path,
        recipient,
        deadline,
      ]),
    });
  } else if (nativeOut) {
    calls.push({
      to: router,
      value: 0n,
      data: routerIface.encodeFunctionData("swapExactTokensForETH", [
        amountInRaw,
        minAmountOutRaw,
        path,
        recipient,
        deadline,
      ]),
    });
  } else {
    calls.push({
      to: router,
      value: 0n,
      data: routerIface.encodeFunctionData("swapExactTokensForTokens", [
        amountInRaw,
        minAmountOutRaw,
        path,
        recipient,
        deadline,
      ]),
    });
  }

  return calls;
}
