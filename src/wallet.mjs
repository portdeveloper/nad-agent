/**
 * WDK wallet layer — the agent's self-custodial account.
 *
 * WDK derives a Safe ERC-4337 smart account (Safe modules v0.3.0 -> EntryPoint
 * v0.7) from the 24-word seed. The seed/key live only on THIS machine. Reads go
 * straight to Monad's RPC; sends go through the Pimlico bundler/paymaster.
 *
 * One seed, many accounts: `manager.getAccount(N)` derives the owner key at
 * BIP-44 path m/44'/60'/0'/0/N, so each index yields its own Safe account.
 * The active index defaults to NAD_ACCOUNT (0 when unset) and can be switched
 * live via /account in the REPL. Address derivation is counterfactual (pure
 * computation, no RPC), so listing accounts works offline.
 *
 * The WDK EVM module is dynamically imported so the SDK only evaluates when a
 * wallet is actually needed (and so the doctor/help paths work without it).
 */

import { config } from "./config.mjs";

let manager = null;
let account = null;
let address = null;
let accountIndex = null;

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

export async function initWallet(index = config.accountIndex) {
  if (!config.seed) {
    throw new Error("WDK_SEED is not set. Generate one with `npm run gen-seed`, then put it in .env");
  }
  const { default: WalletManagerEvmErc4337 } = await import("@tetherto/wdk-wallet-evm-erc-4337");
  manager = new WalletManagerEvmErc4337(config.seed, buildWalletConfig());
  return switchAccount(index);
}

/**
 * Make account `index` the active one. WDK's `manager.getAccount(index)` derives the
 * owner key at BIP-44 path m/44'/60'/0'/0/<index> and counterfactually computes the
 * Safe address from it, so every index maps to a distinct Safe smart account of the
 * same seed. The manager caches accounts per path; dispose() wipes them all.
 */
export async function switchAccount(index) {
  if (!manager) throw new Error("Wallet not initialized");
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Account index must be a non-negative integer (got "${index}")`);
  }
  account = await manager.getAccount(index);
  address = await account.getAddress();
  accountIndex = index;
  return address;
}

/**
 * Derive addresses for accounts 0..count-1 WITHOUT changing the active account.
 * Read-only: uses the same cached-per-path manager, so repeat calls are cheap.
 */
export async function listAccounts(count = 5) {
  if (!manager) throw new Error("Wallet not initialized");
  const out = [];
  for (let i = 0; i < count; i++) {
    const acct = await manager.getAccount(i);
    out.push({ index: i, address: await acct.getAddress(), active: i === accountIndex });
  }
  return out;
}

export function getAddress() {
  return address;
}

export function getAccountIndex() {
  return accountIndex;
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

export function dispose() {
  try {
    // manager.dispose() wipes EVERY cached account (one per derivation path), not
    // just the active one — accounts touched by /account list hold keys too.
    manager?.dispose?.();
  } catch {
    /* ignore */
  }
  manager = account = address = accountIndex = null;
}
