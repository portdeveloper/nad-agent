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
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const ERC721_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function approve(address to, uint256 tokenId)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
];

function getReadProvider() {
  if (!readProvider) readProvider = new JsonRpcProvider(config.chain.rpcUrl, config.chain.chainId);
  return readProvider;
}

/**
 * GET a path from the Reservoir indexer (see config.reservoirUrl).
 *
 * get_nfts goes through Reservoir instead of raw eth_getLogs/Transfer-event scanning:
 * Monad prunes historical state, so an on-chain scan of past transfers is unreliable
 * (this is why the explorer is the source of truth for holdings). Reservoir is the only
 * new network dependency; nothing else about the wallet changes.
 */
async function fetchReservoir(path) {
  if (!config.reservoirApiKey) {
    throw new Error("RESERVOIR_API_KEY is not set. Get a free key at https://reservoir.tools, then put it in .env");
  }
  const res = await fetch(`${config.reservoirUrl}${path}`, { headers: { "x-api-key": config.reservoirApiKey } });
  if (!res.ok) {
    throw new Error(`Reservoir API error ${res.status}${res.statusText ? ` ${res.statusText}` : ""} for ${path}`);
  }
  return res.json();
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

export function normalizeHistoryTransaction(tx, ownerAddress = address) {
  if (!tx || !ownerAddress) return null;
  const owner = String(ownerAddress).toLowerCase();
  const fromAddress = tx.from?.hash ?? tx.from;
  const toAddress = tx.to?.hash ?? tx.to;
  const from = String(fromAddress ?? "").toLowerCase();
  const to = String(toAddress ?? "").toLowerCase();
  if (from !== owner && to !== owner) return null;
  const direction = from === owner ? "out" : "in";
  const amount = BigInt(tx.value ?? 0);
  const hash = tx.hash ?? tx.transaction_hash ?? tx.transactionHash;
  if (!hash) return null;
  return {
    hash,
    direction,
    amount,
    timestamp: tx.timestamp ?? null,
    explorerUrl: `${config.chain.explorerUrl}/tx/${hash}`,
  };
}

async function fetchExplorerItems(path, fetchImpl) {
  const res = await fetchImpl(`${config.chain.explorerUrl}${path}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`MonadScan API error ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
  const data = await res.json();
  return Array.isArray(data) ? data : (data?.items ?? []);
}

/** Read recent native transfers involving the smart account from MonadScan. */
export async function getHistory({ limit = 10, ownerAddress = address, fetchImpl = fetch } = {}) {
  if (!ownerAddress) throw new Error("Wallet not initialized");
  const cap = Math.max(1, Math.min(Number(limit) || 10, 50));
  const owner = checksumAddress(ownerAddress);
  const encoded = encodeURIComponent(owner);
  const results = await Promise.allSettled([
    fetchExplorerItems(`/api/v2/addresses/${encoded}/transactions`, fetchImpl),
    fetchExplorerItems(`/api/v2/addresses/${encoded}/internal-transactions`, fetchImpl),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  if (!fulfilled.length) {
    throw results[0].reason;
  }
  const entries = fulfilled
    .flatMap((result) => result.value)
    .map((tx) => normalizeHistoryTransaction(tx, owner))
    .filter(Boolean)
    .sort((a, b) => String(b.timestamp ?? "").localeCompare(String(a.timestamp ?? "")));
  return entries.slice(0, cap);
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

export async function getAllowance(tokenAddress, spender, ownerAddress = address) {
  if (!ownerAddress) throw new Error("Wallet not initialized");
  const token = new Contract(checksumAddress(tokenAddress), ERC20_ABI, getReadProvider());
  return BigInt(await token.allowance(checksumAddress(ownerAddress), checksumAddress(spender)));
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

export async function quoteTokenSend(to, tokenAddress, amountWei) {
  if (!account) throw new Error("Wallet not initialized");
  if (typeof account.quoteTransfer !== "function") {
    throw new Error("token transfer quote is unavailable");
  }
  return account.quoteTransfer({ token: tokenAddress, recipient: to, amount: amountWei });
}

/**
 * Simulate the ERC-20 call that the smart account will execute.
 *
 * This is deliberately separate from quoteTransfer(): sponsored WDK quotes can return a
 * zero fee without estimating or executing the transfer. An eth_call against the token with
 * the smart-account address as `from` exercises the same ERC-20 balance/recipient checks in
 * both dry-run and gasless modes, without broadcasting or requiring a paymaster round-trip.
 */
export async function simulateTokenSend(to, tokenAddress, amountWei) {
  if (!account || !address) throw new Error("Wallet not initialized");
  const token = new Contract(checksumAddress(tokenAddress), ERC20_ABI, getReadProvider());
  const result = await token.transfer.staticCall(checksumAddress(to), amountWei, {
    from: checksumAddress(address),
  });
  if (result === false) throw new Error("token transfer returned false");
  return { simulated: true };
}

/** How many tokens one Reservoir page returns; the cap the caller is told about. */
const NFT_PAGE_LIMIT = 100;

/**
 * Shape one Reservoir `/users/{owner}/tokens/v7` page into { tokens, skipped, truncated }.
 *
 * Pure, so the mapping is testable without the indexer (same split as
 * normalizeHistoryTransaction).
 *
 * Rows are taken one at a time and a broken one is dropped rather than allowed to escape:
 * the previous `.map()` guarded the container with `entry?.token ?? {}` but not the fields, so
 * `checksumAddress(undefined)` threw out of the map and took the whole response with it. One
 * bad row from the indexer turned "you own 40 NFTs" into an error with none of them.
 *
 * Dropping silently would only move the lie, so what went is counted. `skipped` is that count,
 * and `truncated` says the wallet holds more than this page. Rejecting the one and keeping the
 * rest, with the rejection visible, is how loadAddressBook already handles a bad entry.
 */
export function normalizeNftPage(data) {
  const rows = Array.isArray(data?.tokens) ? data.tokens : [];
  const tokens = [];
  let skipped = 0;
  for (const entry of rows) {
    const t = entry?.token ?? {};
    // A token with no id is not addressable: String(undefined) would put the literal
    // "undefined" in the rendered list and hand it to transfer_nft as a tokenId.
    if (t.tokenId === undefined || t.tokenId === null || String(t.tokenId).trim() === "") {
      skipped += 1;
      continue;
    }
    // checksumAddress throws on anything that is not an address, which is exactly the row to
    // drop rather than let it discard a good response.
    let contract;
    try {
      contract = checksumAddress(t.contract);
    } catch {
      skipped += 1;
      continue;
    }
    tokens.push({
      contract,
      tokenId: String(t.tokenId),
      ...(t.name ? { name: String(t.name) } : {}),
    });
  }
  return { tokens, skipped, truncated: Boolean(data?.continuation) };
}

/**
 * Owned ERC-721 tokens for an address (defaults to the agent's wallet).
 *
 * Reads come from the Reservoir indexer, not eth_getLogs — see fetchReservoir.
 * Returns { tokens, skipped, truncated }; see normalizeNftPage for the shape and why the two
 * counters are part of it.
 */
export async function getNfts(ownerAddress = address) {
  if (!ownerAddress) throw new Error("Wallet not initialized");
  const owner = checksumAddress(ownerAddress);
  const data = await fetchReservoir(`/users/${owner}/tokens/v7?limit=${NFT_PAGE_LIMIT}`);
  // Known follow-up: page past the limit via `continuation` for wallets with more. Until then
  // the caller is at least told the list is partial.
  return normalizeNftPage(data);
}

/**
 * Broadcast (or, in dry-run, simulate) an ERC-721 transfer via safeTransferFrom.
 *
 * Verifies `fromAddress` actually owns the token first — a wrong owner is refused
 * before anything is signed. `fromAddress` defaults to the agent's own wallet and
 * only needs to differ when the agent holds an approval for someone else's NFT.
 * Returns { dryRun } | { userOpHash, hash, fee }.
 */
export async function transferNft(to, contractAddress, tokenId, fromAddress = address) {
  if (!account) throw new Error("Wallet not initialized");
  const token = new Contract(checksumAddress(contractAddress), ERC721_ABI, getReadProvider());
  const owner = checksumAddress(await token.ownerOf(BigInt(tokenId)));
  if (owner.toLowerCase() !== checksumAddress(fromAddress).toLowerCase()) {
    throw new Error(
      `Refused: ${fromAddress} does not own token #${tokenId} on ${contractAddress} — owner is ${owner}`,
    );
  }
  const data = new Interface(ERC721_ABI).encodeFunctionData("safeTransferFrom", [
    checksumAddress(fromAddress),
    checksumAddress(to),
    BigInt(tokenId),
  ]);
  const target = checksumAddress(contractAddress);
  if (config.gasMode === "dry-run") {
    let fee = 0n;
    try {
      const q = await account.quoteSendTransaction({ to: target, value: 0n, data });
      fee = BigInt(q?.fee ?? 0);
    } catch {
      /* estimation may need a bundler; ignore in dry-run */
    }
    return { dryRun: true, to, contract: target, tokenId, fee };
  }
  const res = await account.sendTransaction({ to: target, value: 0n, data });
  const userOpHash = res.hash;
  const hash = await waitForUserOpTxHash(userOpHash);
  return { userOpHash, hash, fee: BigInt(res.fee ?? 0) };
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

/**
 * Broadcast (or, in dry-run, simulate) one or more contract calls as a single
 * UserOperation. An array is atomic: approve + swap land together or not at all.
 * Returns { dryRun, calls, fee } | { userOpHash, hash, fee, calls }.
 */
export async function sendCalls(calls) {
  if (!account) throw new Error("Wallet not initialized");
  if (!Array.isArray(calls) || calls.length === 0) {
    throw new Error("No calls to send");
  }
  if (config.gasMode === "dry-run") {
    try {
      const q = await account.quoteSendTransaction(calls);
      return { dryRun: true, calls, fee: BigInt(q?.fee ?? 0), simulated: true };
    } catch (err) {
      const msg = String(err?.shortMessage || err?.info?.error?.message || err?.message || err);
      // Reverts and bad calldata must not look like a successful dry-run.
      // A missing bundler / network blip is not a simulation of the calls.
      if (/revert|call exception|AA2\d|UserOperation|invalid opcode|execution reverted/i.test(msg)) {
        throw new Error(`dry-run simulation rejected the calls: ${msg}`);
      }
      return { dryRun: true, calls, fee: 0n, simulated: false };
    }
  }
  const res = await account.sendTransaction(calls);
  const userOpHash = res.hash;
  const hash = await waitForUserOpTxHash(userOpHash);
  return { userOpHash, hash, fee: BigInt(res.fee ?? 0), calls };
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
