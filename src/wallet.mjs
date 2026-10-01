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

import { Contract, Interface, JsonRpcProvider, getAddress as checksumAddress } from "ethers";
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

export const ERC721_ABI = [
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
 * `setTimeout`'s ceiling. A larger delay does not wait longer: Node warns and fires after a
 * millisecond, so a deadline above this cancels every request instead of allowing a long one
 * — the opposite of what the caller asked for.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * The deadline a read will actually use, given what the caller asked for.
 *
 * Exported because it is the whole of the rule and it is pure. Asserting it through a request
 * means either racing a live response against a one-millisecond timer or waiting out a
 * twenty-four-day one, and neither says anything this arithmetic does not.
 *
 * Three outcomes, not two: a usable duration is floored and capped, an oversized finite one
 * is capped to the longest wait available, and anything that names no usable duration — `NaN`,
 * `Infinity`, below a millisecond, a word — takes the default. Node sets any delay under 1 to
 * 1 ms, which is why a sub-millisecond value belongs with the fallbacks rather than with the
 * short waits.
 */
export function resolveDeadline(timeoutMs, fallbackMs) {
  const requested = Number(timeoutMs);
  // Floored, not passed through: setTimeout truncates a fraction anyway, and the deadline is
  // quoted back in the timeout message — "timed out after 1.9ms" would claim a wait no timer
  // ever honoured. The number the caller is told is the number that was used.
  //
  // Infinity falls back rather than being capped, and the difference is the point of the
  // guard. A finite number is a duration the caller named: asking for longer than setTimeout
  // can express is asking for the longest wait available, so it is capped. Infinity names no
  // duration at all — capping it to 24.9 days would hand back the unbounded wait that #92 and
  // #93 exist to remove, dressed as a deadline.
  return Number.isFinite(requested) && requested >= 1
    ? Math.min(Math.floor(requested), MAX_TIMEOUT_MS)
    : fallbackMs;
}

// Same shape of deadline as the explorer reads in #93, and for the same reason: a stalled
// indexer otherwise keeps get_nfts waiting forever. Kept separate from EXPLORER_TIMEOUT_MS
// because these are different services, and a slow indexer should not shorten history reads.
const NFT_TIMEOUT_MS = 10_000;

/**
 * GET a path from the Reservoir indexer (see config.reservoirUrl).
 *
 * get_nfts goes through Reservoir instead of raw eth_getLogs/Transfer-event scanning:
 * Monad prunes historical state, so an on-chain scan of past transfers is unreliable
 * (this is why the explorer is the source of truth for holdings). Reservoir is the only
 * new network dependency; nothing else about the wallet changes.
 */
async function fetchReservoir(path, { fetchImpl = fetch, timeoutMs = NFT_TIMEOUT_MS } = {}) {
  // No indexer for this network → refuse. Checked before the key so a mainnet operator
  // isn't sent to fetch a key for a host that doesn't exist. Reservoir has no Monad
  // mainnet endpoint, and answering from the testnet one would report another chain's
  // holdings as if they were mainnet — the address is the same on both, so nothing
  // about the answer would look wrong. See NETWORKS in config.mjs.
  if (!config.reservoirUrl) {
    throw new Error(
      `Refused: no NFT indexer is configured for ${config.chain.name}. ` +
        `Reservoir does not index Monad mainnet, and reading testnet holdings here would be wrong. ` +
        `Set RESERVOIR_API_URL in .env to an indexer for this network to enable NFT reads.`,
    );
  }
  if (!config.reservoirApiKey) {
    throw new Error("RESERVOIR_API_KEY is not set. Get a free key at https://reservoir.tools, then put it in .env");
  }
  const deadline = resolveDeadline(timeoutMs, NFT_TIMEOUT_MS);
  // One controller covers the request AND the body read. A response whose headers arrive and
  // whose JSON then stalls hangs just as completely as one that never answers, and aborting
  // after the headers still tears the body stream down. Cleared in `finally` so a normal answer
  // leaves no pending timer holding the event loop open.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadline);
  try {
    const res = await fetchImpl(`${config.reservoirUrl}${path}`, {
      headers: { "x-api-key": config.reservoirApiKey },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Reservoir API error ${res.status}${res.statusText ? ` ${res.statusText}` : ""} for ${path}`);
    }
    return await res.json();
  } catch (err) {
    // The abort surfaces as an AbortError whose message is about a signal, which tells a wallet
    // user nothing. Say which read timed out and after how long; everything else passes through.
    if (controller.signal.aborted) {
      throw new Error(`NFT read timed out after ${deadline}ms: the indexer did not answer for ${path}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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

/**
 * The native amount an explorer row carries, or `null` when it carries none.
 *
 * `BigInt` is generous in ways an explorer row is not: `""`, `[]` and `false` all become 0,
 * `true` becomes 1, `["5"]` unwraps to 5, and an object with a `toString` becomes whatever
 * it says. None of those is an amount, and converting them invents a transfer the chain
 * never saw — a row printed as `+0.0 MON` reads as a real zero-value transaction, not as a
 * row we failed to understand. The rest (`"not-a-number"`, `"1.5"`, `NaN`, a bare object)
 * makes `BigInt` throw, which used to take the whole history down with it.
 *
 * So: only a string, a number or a bigint is considered at all, and only a whole
 * non-negative one survives. What `BigInt` itself accepts is left alone: hex, binary and
 * octal literals, a leading `+`, surrounding whitespace. `0x2a` is already pinned as a
 * readable row by the suite, and narrowing the grammar is not what this guard is for —
 * inventing an amount out of something that carries none is.
 */
function parseHistoryAmount(value) {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  let amount;
  try {
    amount = BigInt(value);
  } catch {
    return null;
  }
  // A negative native amount is not a direction, it is a malformed row: `/history` prints
  // the sign from `direction`, so -5 wei arrives as "in  +-0.000000000000000005 MON".
  return amount < 0n ? null : amount;
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
  const amount = parseHistoryAmount(tx.value);
  if (amount === null) return null;
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

/**
 * How long one explorer request may take, headers and body together. A slow MonadScan is
 * not what this guards against: a request that never settles is, because `/history` waits
 * for both endpoints and the REPL waits for `/history`.
 */
const EXPLORER_TIMEOUT_MS = 10_000;

async function fetchExplorerItems(path, fetchImpl, timeoutMs) {
  // Clamped here rather than by the caller, so this wrapper and fetchReservoir resolve their
  // own argument the same way. The rule is one function; leaving two call shapes around it is
  // how the next copy picks the wrong one.
  const deadline = resolveDeadline(timeoutMs, EXPLORER_TIMEOUT_MS);
  // One controller covers the body read as well as the headers. A response whose headers
  // arrive and whose body then stalls hangs just as completely as one that never answers,
  // and aborting after the headers still tears the body stream down. The timer is cleared
  // in `finally` so a normal answer leaves nothing pending holding the event loop open.
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`MonadScan request timed out after ${deadline}ms`)),
    deadline,
  );
  try {
    const res = await fetchImpl(`${config.chain.explorerUrl}${path}`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`MonadScan API error ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
    const data = await res.json();
    return Array.isArray(data) ? data : (data?.items ?? []);
  } finally {
    clearTimeout(timer);
  }
}

/** Read recent native transfers involving the smart account from MonadScan. */
export async function getHistory({
  limit = 10,
  ownerAddress = address,
  fetchImpl = fetch,
  timeoutMs = EXPLORER_TIMEOUT_MS,
} = {}) {
  if (!ownerAddress) throw new Error("Wallet not initialized");
  const cap = Math.max(1, Math.min(Number(limit) || 10, 50));
  const owner = checksumAddress(ownerAddress);
  const encoded = encodeURIComponent(owner);
  const sources = [
    ["transactions", `/api/v2/addresses/${encoded}/transactions`],
    ["internal transactions", `/api/v2/addresses/${encoded}/internal-transactions`],
  ];
  const results = await Promise.allSettled(
    sources.map(([, path]) => fetchExplorerItems(path, fetchImpl, timeoutMs)),
  );
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  if (!fulfilled.length) {
    // Both endpoints are gone. Rethrowing only `results[0].reason` dropped the second one,
    // and a timeout's own reason names a URL path rather than which half of the history is
    // missing. `/history` prints this message and, scripted, exits non-zero on it, so it
    // has to say which sources failed and why.
    const reasons = results.map((result) => result.reason);
    throw new AggregateError(
      reasons,
      `history unavailable: ${sources
        .map(([label], i) => `${label} — ${reasons[i]?.message ?? reasons[i]}`)
        .join("; ")}`,
    );
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
    // The id is checked with the transfer path's own rule, and before anything coerces it.
    // String() was the first thing to touch it, which went wrong three ways: a missing id
    // listed as "undefined", a number past 2^53 had already been rounded by JSON.parse and
    // listed as a plausible id the wallet does not hold, and an id whose toString is not
    // callable threw out of the loop and discarded every good row on the page. One rule for
    // both paths, so a listed id is always one transfer_nft will accept as written.
    try {
      requireTokenId(t.tokenId);
    } catch {
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
    // Same shape of problem as the tokenId, one step quieter: String() on a non-string name
    // renders "[object Object]" into the list. A name is decoration, so a malformed one is
    // dropped and the token still shows under its id.
    const name = typeof t.name === "string" && t.name ? t.name : undefined;
    tokens.push({
      contract,
      // Safe now: only a string, a safe integer or a bigint gets here, and a string is listed
      // exactly as the indexer wrote it, so a large id keeps its digits.
      tokenId: String(t.tokenId),
      ...(name ? { name } : {}),
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
export async function getNfts(ownerAddress = address, { fetchImpl = fetch, timeoutMs = NFT_TIMEOUT_MS } = {}) {
  if (!ownerAddress) throw new Error("Wallet not initialized");
  const owner = checksumAddress(ownerAddress);
  const data = await fetchReservoir(`/users/${owner}/tokens/v7?limit=${NFT_PAGE_LIMIT}`, { fetchImpl, timeoutMs });
  // Known follow-up: page past the limit via `continuation` for wallets with more. Until then
  // the caller is at least told the list is partial.
  return normalizeNftPage(data);
}

/** The largest id an ERC-721 `uint256` can hold. */
const MAX_TOKEN_ID = (1n << 256n) - 1n;

/**
 * The token id a caller named, or a refusal.
 *
 * `BigInt` alone is not a check: `""`, `"  "`, `[]` and `false` all reach it as 0, which is a
 * real token id and so arrives as a complete, signable transfer of token #0 that nobody asked
 * for. Everything else it dislikes throws a converter error instead — the only field on this
 * path that still reaches ethers unchecked, which is what #79 fixed for `fromAddress` and what
 * the comment at src/tools.mjs:1001 describes.
 *
 * So: only a string, a number or a bigint is considered, an empty or blank string is not a
 * value, and the result has to fit the `uint256` the ABI declares. Hex stays welcome; `"0"`
 * stays a token id, which is exactly what `""` must stop being.
 *
 * normalizeNftPage applies the same rule to indexer rows, so an id get_nfts lists is one this
 * accepts; change it here and both paths move together.
 *
 * Throws rather than returning null because both refusals already in this file throw, and the
 * value is deliberately left out of the message: `transferNft` echoes a raw tokenId at its
 * wrong-owner refusal, and a second unescaped echo is not something to add here.
 */
function requireTokenId(tokenId) {
  // A number is only usable when it is a safe integer. Past 2^53 a JSON number no longer
  // carries the id it was written as, so accepting one here would encode a token nobody named,
  // exactly as an empty string used to encode token #0. Strings and bigints keep the full
  // uint256 range: "9007199254740993" is a legal id and stays one.
  const usable =
    typeof tokenId === "string"
      ? tokenId.trim() !== ""
      : typeof tokenId === "number"
        ? Number.isSafeInteger(tokenId)
        : typeof tokenId === "bigint";
  if (usable) {
    try {
      const id = BigInt(tokenId);
      if (id >= 0n && id <= MAX_TOKEN_ID) return id;
    } catch {
      /* not a number in any notation — falls through to the refusal */
    }
  }
  throw new Error(
    "Refused: tokenId must be a whole number from 0 to 2^256-1; " +
      "pass ids above 2^53 as a decimal or hex string.",
  );
}

/**
 * Calldata for one `safeTransferFrom`. Split out so the encoding is reachable
 * from a test without a wallet or a network, the way buildSwapCalls is.
 */
export function buildNftTransferCalldata(fromAddress, to, tokenId) {
  return new Interface(ERC721_ABI).encodeFunctionData("safeTransferFrom", [
    checksumAddress(fromAddress),
    checksumAddress(to),
    requireTokenId(tokenId),
  ]);
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
  // Resolved before the session check, for two reasons. A malformed argument is the caller's
  // to fix whether or not a wallet is open, and it is what makes this refusal reachable from a
  // test at all — every other statement in this function needs an initialised wallet. Same
  // rule as the encoder below, resolved here rather than taken from the caller so the two
  // cannot agree on a token nobody named: BigInt("") made this ask about #0 and the calldata
  // encode #0.
  const id = requireTokenId(tokenId);
  if (!account) throw new Error("Wallet not initialized");
  const token = new Contract(checksumAddress(contractAddress), ERC721_ABI, getReadProvider());
  const owner = checksumAddress(await token.ownerOf(id));
  if (owner.toLowerCase() !== checksumAddress(fromAddress).toLowerCase()) {
    throw new Error(
      `Refused: ${fromAddress} does not own token #${tokenId} on ${contractAddress} — owner is ${owner}`,
    );
  }
  const data = buildNftTransferCalldata(fromAddress, to, tokenId);
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
