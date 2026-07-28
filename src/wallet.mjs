/**
 * WDK wallet layer — the agent's self-custodial account.
 *
 * WDK derives a Safe ERC-4337 smart account (Safe modules v0.3.0 -> EntryPoint
 * v0.7) from the 24-word seed. The seed/key live only on THIS machine. Reads go
 * straight to Monad's RPC; sends go through the Pimlico bundler/paymaster.
 *
 * The WDK EVM module is dynamically imported so the SDK only evaluates when a
 * wallet is actually needed (and so the doctor/help paths work without it).
 */

import { Contract, Interface, JsonRpcProvider, getAddress as checksum } from "ethers";
import { config } from "./config.mjs";

let manager = null;
let account = null;
let address = null;
let provider = null;

// ── DEX plumbing (PuddleSwap, Uniswap-V2-style) ─────────────────────────────
// Only the four router functions and the two ERC-20 views the swap flow needs.
// Shapes match the PuddleSwap web app's own quote/swap path: quote with
// getAmountsOut over candidate paths, then swapExact{Tokens,ETH}For… with an
// explicit amountOutMin. Kept inline (no SDK dependency) so the agent stays a
// plain RPC client.
const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
];
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

/** Swap deadline: 10 minutes from now, in seconds (uint256 for the router). */
export const SWAP_DEADLINE_SECONDS = 10 * 60;

/**
 * A read-only provider for eth_call. Independent of the WDK account so quotes
 * work with no seed, no Pimlico key and in dry-run mode.
 */
function readProvider() {
  if (!provider) {
    provider = new JsonRpcProvider(config.chain.rpcUrl, config.chain.chainId, { staticNetwork: true });
  }
  return provider;
}

function requireDex() {
  const dex = config.chain.dex;
  if (!dex) {
    throw new Error(`No DEX is configured for ${config.chain.name}. Swaps are testnet-only for now.`);
  }
  return dex;
}

/**
 * Resolve a token the user named by symbol ("USDC") or by address ("0x…").
 * Known symbols come from the built-in list; an address not in the list is read
 * on-chain for its symbol/decimals so the agent is not limited to the list.
 * Returns { symbol, address, decimals, native }.
 */
export async function resolveToken(nameOrAddress) {
  const dex = requireDex();
  const input = String(nameOrAddress ?? "").trim();
  if (!input) throw new Error("No token given.");

  // Native MON: the router wraps/unwraps it, so it carries the WMON address.
  if (input.toUpperCase() === config.chain.symbol) {
    return { symbol: config.chain.symbol, address: checksum(dex.wrappedNative), decimals: 18, native: true };
  }

  const bySymbol = dex.tokens.find((t) => t.symbol.toUpperCase() === input.toUpperCase());
  if (bySymbol) return { ...bySymbol, address: checksum(bySymbol.address), native: false };

  if (!/^0x[0-9a-fA-F]{40}$/.test(input)) {
    const known = [config.chain.symbol, ...dex.tokens.map((t) => t.symbol)].join(", ");
    throw new Error(`Unknown token "${input}". Known: ${known}. Or pass a 0x token address.`);
  }

  const address = checksum(input);
  const erc20 = new Contract(address, ERC20_ABI, readProvider());
  const [symbol, decimals] = await Promise.all([erc20.symbol(), erc20.decimals()]);
  return { symbol, address, decimals: Number(decimals), native: false };
}

function buildWalletConfig() {
  const { chain, gasMode, bundlerUrl, sponsorshipPolicyId } = config;
  const base = {
    chainId: chain.chainId,
    provider: chain.rpcUrl,
    safeModulesVersion: "0.3.0",
    onChainIdentifier: "nad-agent",
  };
  if (gasMode === "dry-run") {
    // No bundler: reads work; writes are intercepted in send() and simulated.
    return base;
  }
  base.bundlerUrl = bundlerUrl;
  if (gasMode === "sponsored") {
    return {
      ...base,
      isSponsored: true,
      paymasterUrl: bundlerUrl,
      ...(sponsorshipPolicyId ? { sponsorshipPolicyId } : {}),
    };
  }
  // native: user pays gas in MON
  return { ...base, useNativeCoins: true };
}

export async function initWallet() {
  if (!config.seed) {
    throw new Error("WDK_SEED is not set. Generate one with `npm run gen-seed`, then put it in .env");
  }
  const { default: WalletManagerEvmErc4337 } = await import("@tetherto/wdk-wallet-evm-erc-4337");
  manager = new WalletManagerEvmErc4337(config.seed, buildWalletConfig());
  account = await manager.getAccount(0);
  address = await account.getAddress();
  return address;
}

export function getAddress() {
  return address;
}

export async function getBalance() {
  if (!account) throw new Error("Wallet not initialized");
  return account.getBalance(); // bigint wei
}

export async function quoteSend(to, valueWei) {
  if (!account) throw new Error("Wallet not initialized");
  return account.quoteSendTransaction({ to, value: valueWei });
}

/**
 * Broadcast (or, in dry-run, simulate) a native MON transfer.
 * Returns { dryRun } | { userOpHash, hash, fee }.
 */
export async function send(to, valueWei) {
  if (!account) throw new Error("Wallet not initialized");
  if (config.gasMode === "dry-run") {
    // Best-effort quote so the dry-run still exercises the estimation path.
    let fee = 0n;
    try {
      const q = await account.quoteSendTransaction({ to, value: valueWei });
      fee = BigInt(q?.fee ?? 0);
    } catch {
      /* estimation may need a bundler; ignore in dry-run */
    }
    return { dryRun: true, to, value: valueWei, fee };
  }
  const res = await account.sendTransaction({ to, value: valueWei });
  // IMPORTANT: res.hash is the ERC-4337 *userOpHash*, NOT an on-chain tx hash. The
  // bundler wraps the UserOperation into a real transaction; the actual tx hash only
  // exists once it's mined. Resolve it from the userOp receipt so the explorer link
  // points at a real transaction instead of an unresolvable userOpHash.
  const userOpHash = res.hash;
  const hash = await waitForUserOpTxHash(userOpHash);
  return { userOpHash, hash, fee: BigInt(res.fee ?? 0) };
}

/** Poll the bundler for the UserOperation receipt; return the on-chain tx hash (or null). */
async function waitForUserOpTxHash(userOpHash, { tries = 40, delayMs = 1500 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await account.getUserOperationReceipt(userOpHash);
      const h = r?.receipt?.transactionHash ?? r?.transactionHash;
      if (h) return h;
    } catch {
      /* not indexed yet / transient bundler error — keep polling */
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null; // not included within the window; caller falls back to the userOpHash
}

// ── Swap: quote ─────────────────────────────────────────────────────────────

/**
 * Candidate paths from tokenIn to tokenOut: the direct pair first, then one hop
 * through each other known token. Uniswap-V2 routers price a path pool by pool,
 * so a missing direct pool can still be routed (USDC->WMON->USDT). Native MON is
 * represented by WMON in the path; the router wraps it.
 */
function candidatePaths(tokenIn, tokenOut) {
  const dex = requireDex();
  const paths = [[tokenIn.address, tokenOut.address]];
  for (const hop of dex.tokens) {
    const via = checksum(hop.address);
    if (via === tokenIn.address || via === tokenOut.address) continue;
    paths.push([tokenIn.address, via, tokenOut.address]);
  }
  return paths;
}

/**
 * Ask the router for getAmountsOut on every candidate path and keep the best.
 * Pure eth_call, so this is real even in dry-run with no key and no funds. A
 * path with no pool reverts; that candidate is skipped, not fatal.
 * Returns { path, amountOut, amountInRaw, tokenIn, tokenOut }.
 */
export async function quoteSwap(tokenIn, tokenOut, amountInRaw) {
  const dex = requireDex();
  const router = new Contract(checksum(dex.router), ROUTER_ABI, readProvider());

  const paths = candidatePaths(tokenIn, tokenOut);
  const results = await Promise.all(
    paths.map(async (path) => {
      try {
        const amounts = await router.getAmountsOut(amountInRaw, path);
        return { path, amountOut: BigInt(amounts[amounts.length - 1]) };
      } catch {
        return null; // no pool for this path, or zero liquidity
      }
    })
  );

  let best = null;
  for (const r of results) {
    if (r && r.amountOut > 0n && (!best || r.amountOut > best.amountOut)) best = r;
  }
  if (!best) {
    throw new Error(`No ${dex.name} route with liquidity for ${tokenIn.symbol} -> ${tokenOut.symbol}.`);
  }
  return { ...best, amountInRaw, tokenIn, tokenOut };
}

/**
 * Minimum acceptable output at the given slippage tolerance. Percent -> basis
 * points with Math.floor, then integer bigint math, so there is no float
 * rounding in the on-chain bound. This is the same math the PuddleSwap app uses.
 */
export function applySlippage(amountOut, slippagePercent) {
  const bps = BigInt(Math.floor(slippagePercent * 100));
  return amountOut - (amountOut * bps) / 10_000n;
}

/** Current router allowance for an ERC-20 the account is about to spend. */
export async function getAllowance(tokenAddress, owner) {
  const dex = requireDex();
  const erc20 = new Contract(checksum(tokenAddress), ERC20_ABI, readProvider());
  return BigInt(await erc20.allowance(owner, checksum(dex.router)));
}

/** ERC-20 balance of the account, raw units. */
export async function getTokenBalance(tokenAddress, owner) {
  const erc20 = new Contract(checksum(tokenAddress), ERC20_ABI, readProvider());
  return BigInt(await erc20.balanceOf(owner));
}

// ── Swap: build + send ──────────────────────────────────────────────────────

/**
 * Build the calls for a swap: an ERC-20 approve first when the router needs a
 * bigger allowance, then the router swap itself.
 *
 * Which router function to call follows the direction, exactly like the
 * PuddleSwap app: native in -> swapExactETHForTokens (amount rides as msg.value),
 * native out -> swapExactTokensForETH, token to token -> swapExactTokensForTokens.
 *
 * Returns an array of { to, value, data } WDK transactions. WDK's ERC-4337
 * account takes an array and batches the calls into ONE UserOperation, so the
 * approve and the swap land atomically in a single on-chain transaction. That
 * also means the approve cannot be front-run between the two calls.
 */
export function buildSwapCalls({ path, amountInRaw, minAmountOutRaw, recipient, nativeIn, nativeOut, needsApproval }) {
  const dex = requireDex();
  const router = checksum(dex.router);
  const routerIface = new Interface(ROUTER_ABI);
  const erc20Iface = new Interface(ERC20_ABI);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + SWAP_DEADLINE_SECONDS);
  const calls = [];

  if (needsApproval && !nativeIn) {
    // Approve exactly amountIn, not an unlimited allowance: the agent holds the
    // keys, so a leftover infinite approval is standing risk for no gain.
    calls.push({
      to: checksum(path[0]),
      value: 0,
      data: erc20Iface.encodeFunctionData("approve", [router, amountInRaw]),
    });
  }

  if (nativeIn) {
    calls.push({
      to: router,
      value: amountInRaw,
      data: routerIface.encodeFunctionData("swapExactETHForTokens", [minAmountOutRaw, path, recipient, deadline]),
    });
  } else if (nativeOut) {
    calls.push({
      to: router,
      value: 0,
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
      value: 0,
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

/**
 * Broadcast (or, in dry-run, simulate) a swap. Mirrors send(): dry-run still
 * quotes so the estimation path is exercised, and a real send resolves the
 * on-chain tx hash from the UserOperation receipt rather than returning the
 * userOpHash.
 * Returns { dryRun, calls, fee } | { userOpHash, hash, fee, calls }.
 */
export async function sendSwap(calls) {
  if (!account) throw new Error("Wallet not initialized");
  if (config.gasMode === "dry-run") {
    let fee = 0n;
    try {
      const q = await account.quoteSendTransaction(calls);
      fee = BigInt(q?.fee ?? 0);
    } catch {
      /* estimation needs a bundler; ignore in dry-run */
    }
    return { dryRun: true, calls, fee };
  }
  const res = await account.sendTransaction(calls);
  const userOpHash = res.hash;
  const hash = await waitForUserOpTxHash(userOpHash);
  return { userOpHash, hash, fee: BigInt(res.fee ?? 0), calls };
}

export function dispose() {
  try {
    account?.dispose?.();
  } catch {
    /* ignore */
  }
  manager = account = address = null;
  provider = null;
}
