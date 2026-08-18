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

import { Contract, JsonRpcProvider, getAddress as checksumAddress, Interface, ZeroAddress } from "ethers";
import { config, setAccountIndex } from "./config.mjs";

let manager = null;
let account = null;
let address = null;
let accountIndex = null;
let readProvider = null;

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

function getReadProvider() {
  if (!readProvider) readProvider = new JsonRpcProvider(config.chain.rpcUrl, config.chain.chainId);
  return readProvider;
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

export function validateAccountIndex(idx) {
  if (!Number.isInteger(idx) || idx < 0 || idx > 999) {
    throw new Error(`WDK_ACCOUNT_INDEX must be a non-negative integer <= 999, got: ${idx}`);
  }
}

export async function initWallet() {
  if (!config.seed) {
    throw new Error("WDK_SEED is not set. Generate one with `npm run gen-seed`, then put it in .env");
  }
  validateAccountIndex(config.accountIndex);
  const { default: WalletManagerEvmErc4337 } = await import("@tetherto/wdk-wallet-evm-erc-4337");
  manager = new WalletManagerEvmErc4337(config.seed, buildWalletConfig());
  // Start at config.accountIndex (default 0 = v0 behavior).
  account = await manager.getAccount(config.accountIndex);
  accountIndex = config.accountIndex;
  address = await account.getAddress();
  return address;
}

export function getAddress() {
  return address;
}

/** The currently active BIP-44 account index (0 = default). */
export function getActiveAccountIndex() {
  return accountIndex ?? 0;
}

/**
 * Switch to a different derived account by BIP-44 index.
 * The same seed, different index → different address.
 * Returns the new address.
 */
export async function switchAccount(index) {
  if (!manager) throw new Error("Wallet not initialized");
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i > 999) throw new Error(`Invalid account index: ${index}`);
  // Derive the candidate account and resolve its address FIRST. If either step
  // throws, the running wallet stays untouched — there is no half-switched state.
  const candidate = await manager.getAccount(i);
  const newAddress = await candidate.getAddress();
  // Persist only after both derive and address resolution succeeded.
  setAccountIndex(i);
  account = candidate;
  address = newAddress;
  accountIndex = i;
  return address;
}

/**
 * Derive N accounts from the seed (indices 0..count-1) and return
 * their addresses. Index 0 is always included.
 * In dry-run mode we still derive keys locally (no RPC needed).
 */
export async function listAccounts(count = 5) {
  if (!manager) throw new Error("Wallet not initialized");
  const n = Math.max(1, Math.min(Number(count), 20));
  const accounts = [];
  for (let i = 0; i < n; i++) {
    const acc = await manager.getAccount(i);
    accounts.push({ index: i, address: await acc.getAddress() });
  }
  return accounts;
}

export async function getBalance() {
  if (!account) throw new Error("Wallet not initialized");
  return account.getBalance(); // bigint wei
}

export async function getTokenBalance(tokenAddress, ownerAddress = address) {
  if (!ownerAddress) throw new Error("Wallet not initialized");
  const token = new Contract(checksumAddress(tokenAddress), ERC20_ABI, getReadProvider());
  return BigInt(await token.balanceOf(checksumAddress(ownerAddress)));
}

export async function getTokenMetadata(tokenAddress) {
  const address = checksumAddress(tokenAddress);
  const token = new Contract(address, ERC20_ABI, getReadProvider());
  const [symbol, decimals, name] = await Promise.allSettled([
    token.symbol(),
    token.decimals(),
    token.name(),
  ]);
  return {
    address,
    ...(symbol.status === "fulfilled" ? { symbol: String(symbol.value) } : {}),
    ...(decimals.status === "fulfilled" ? { decimals: Number(decimals.value) } : {}),
    ...(name.status === "fulfilled" ? { name: String(name.value) } : {}),
  };
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
  const userOpHash = res.hash;
  const hash = await waitForUserOpTxHash(userOpHash);
  return { userOpHash, hash, fee: BigInt(res.fee ?? 0) };
}

/**
 * Broadcast (or, in dry-run, simulate) an ERC-20 token transfer.
 * Uses WDK's native transfer() which builds the ERC-20 transfer userOp.
 * Returns { dryRun } | { userOpHash, hash, fee }.
 */
export async function sendToken(to, tokenAddress, amountWei) {
  if (!account) throw new Error("Wallet not initialized");
  if (config.gasMode === "dry-run") {
    let fee = 0n;
    try {
      const q = await account.quoteTransfer?.({ token: tokenAddress, recipient: to, amount: amountWei });
      fee = BigInt(q?.fee ?? 0);
    } catch {
      /* estimation may need a bundler; ignore in dry-run */
    }
    return { dryRun: true, to, token: tokenAddress, value: amountWei, fee };
  }
  const res = await account.transfer({ token: tokenAddress, recipient: to, amount: amountWei });
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
    account?.dispose?.();
  } catch {
    /* ignore */
  }
  try {
    readProvider?.destroy?.();
  } catch {
    /* ignore */
  }
  manager = account = address = readProvider = null;
  accountIndex = null;
}
