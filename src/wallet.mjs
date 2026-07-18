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

import { Contract, JsonRpcProvider, getAddress as checksumAddress } from "ethers";
import { config } from "./config.mjs";

let manager = null;
let account = null;
let address = null;
let readProvider = null;

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
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
}
