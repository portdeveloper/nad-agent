/**
 * Env-driven configuration. This is the ONLY file that differs in behavior
 * between machines — and it does so purely by reading environment variables.
 * The same built code runs on this Linux dev box (tiny CPU model, dry-run) and
 * on an M4 Max (big Metal model, real gasless sends).
 *
 * Monad is EVM-equivalent, so WDK's ERC-4337 modules work by pointing `provider`
 * at a Monad RPC + chainId — values from docs.monad.xyz.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const NETWORKS = {
  testnet: {
    chainId: 10143,
    name: "Monad Testnet",
    rpcUrl: "https://testnet-rpc.monad.xyz",
    explorerUrl: "https://testnet.monadscan.com",
    symbol: "MON",
    // PuddleSwap — portdeveloper's Uniswap-V2 DEX on this testnet (RPC-only).
    // Addresses from https://github.com/portdeveloper/puddleswap (config/addresses/10143.json).
    // WMON here is PuddleSwap's wrap (pools live against it), which is NOT the
    // canonical testnet WMON used for balance reads in tokens.mjs.
    dex: {
      name: "PuddleSwap",
      router: "0x430c23895c8D44883526e3E0B09327dAD8766660",
      wrappedNative: "0x97B3070F9Da6C002343862b35E68Bd8e22608943",
      canonicalWrappedNative: "0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541",
      tokens: [
        { symbol: "WMON", address: "0x97B3070F9Da6C002343862b35E68Bd8e22608943", decimals: 18 },
        { symbol: "USDC", address: "0x534b2f3A21130d7a60830c2Df862319e593943A3", decimals: 6 },
        { symbol: "USDT", address: "0x1314b22df27BDcD4F8D11a0f4185943e55748917", decimals: 6 },
      ],
    },
  },
  mainnet: {
    chainId: 143,
    name: "Monad Mainnet",
    rpcUrl: "https://rpc.monad.xyz",
    explorerUrl: "https://monadscan.com",
    symbol: "MON",
    dex: null, // no vetted mainnet DEX pinned — the swap action refuses here
  },
};

const network = process.env.MONAD_NETWORK === "mainnet" ? "mainnet" : "testnet";
const chain = { network, ...NETWORKS[network] };
if (process.env.MONAD_RPC_URL) chain.rpcUrl = process.env.MONAD_RPC_URL;

const pimlicoKey = process.env.PIMLICO_API_KEY || "";
const sponsorshipPolicyId = process.env.PIMLICO_SPONSORSHIP_POLICY_ID || "";
const gasOverride = (process.env.WDK_GAS_MODE || "").toLowerCase();

// NFT reads (get_nfts) go through Reservoir's indexed API, not raw eth_getLogs:
// Monad prunes historical state, so Transfer-event scanning is unreliable. The
// default is Monad testnet; override the base URL for mainnet or a different indexer.
const reservoirApiKey = process.env.RESERVOIR_API_KEY || "";
const reservoirUrl = process.env.RESERVOIR_API_URL || "https://api-monad-testnet.reservoir.tools";

// Resolve the effective gas mode:
//   dry-run   -> simulate sends (no bundler needed). Auto-selected when no Pimlico key.
//   sponsored -> gasless via Pimlico paymaster (agent pays 0)
//   native    -> you-pay-gas in MON (still needs a bundler = Pimlico key)
let gasMode;
if (gasOverride === "dry-run" || !pimlicoKey) gasMode = "dry-run";
else if (gasOverride === "native") gasMode = "native";
else gasMode = "sponsored";

// Slippage tolerance for swaps, in percent. Clamped to (0, 50]; a nonsense
// value falls back to 1% (PuddleSwap's default). Override with SWAP_SLIPPAGE_PERCENT.
const rawSlippage = Number(process.env.SWAP_SLIPPAGE_PERCENT || 1);
const slippagePercent = rawSlippage > 0 && rawSlippage <= 50 ? rawSlippage : 1;

const _home = homedir();
if (!_home) throw new Error("Cannot determine home directory — set HOME env var");

function getStatePath() {
  // NAD_STATE_PATH lets tests (and power users) redirect state to any file.
  // Evaluated at call time so test setup that sets the env var after import
  // is respected.
  const override = process.env.NAD_STATE_PATH;
  if (override) return override;
  const dir = join(_home, ".nad-agent");
  return join(dir, "state.json");
}

function readState() {
  const path = getStatePath();
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    console.error(`[nad-agent] warning: could not read state at ${path}: ${err.message}`);
    // Propagate non-ENOENT errors so callers don't silently corrupt state.
    throw err;
  }
}

function writeState(obj) {
  const path = getStatePath();
  mkdirSync(dirname(path), { recursive: true });
  // Read-modify-write: merge with existing state so future keys aren't lost.
  // If the existing file is corrupted (bad JSON), treat it as empty — we're
  // about to write a fresh file anyway. But propagate real I/O errors (e.g.,
  // permission denied) so we don't silently wipe state we couldn't read.
  let existing = {};
  try {
    existing = readState();
  } catch (err) {
    if (err.code !== "ENOENT" && err.name !== "SyntaxError") throw err;
    // ENOENT (no file yet) or SyntaxError (corrupted JSON) → start fresh.
  }
  const merged = { ...existing, ...obj };
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(merged, null, 2));
  renameSync(tmp, path); // atomic on POSIX
}

// Start from env (default 0), then let the persisted state override it.
let _accountIndex = Number(process.env.WDK_ACCOUNT_INDEX || 0);
try {
  const saved = readState().accountIndex;
  if (Number.isInteger(saved) && saved >= 0 && saved <= 999) _accountIndex = saved;
} catch { /* ignore */ }

export function getAccountIndex() {
  return _accountIndex;
}

export function setAccountIndex(idx) {
  if (!Number.isInteger(idx) || idx < 0 || idx > 999) return;
  writeState({ accountIndex: idx });
  _accountIndex = idx;
}

const useNativeToolsEnv = (process.env.USE_NATIVE_TOOLS || "true").toLowerCase();
const useNativeTools = useNativeToolsEnv === "true" || useNativeToolsEnv === "1";

export const config = {
  chain,
  // Convenience flag for guardrails: mainnet moves real funds.
  isMainnet: network === "mainnet",
  gasMode,
  slippagePercent,
  sponsorshipPolicyId,
  // ERC-4337 needs a bundler+paymaster. For a LOCAL CLI the Pimlico key stays on
  // this machine, so we can hit Pimlico directly — no server proxy needed (unlike
  // the browser wallet, where the key had to be proxied).
  bundlerUrl: pimlicoKey
    ? `https://api.pimlico.io/v2/${chain.chainId}/rpc?apikey=${pimlicoKey}`
    : "",
  // Which derived account to use (BIP-44 index). This is a LIVE getter backed by
  // _accountIndex — not a snapshot from module-load time — so initWallet always
  // picks up the persisted value. Default 0 keeps v0 behavior.
  get accountIndex() { return _accountIndex; },
  seed: process.env.WDK_SEED || "",
  // Native tool-calling vs v0 JSON protocol. Set USE_NATIVE_TOOLS=false to fall back
  // to the hand-rolled JSON-parsing protocol for small/dev models.
  useNativeTools,
  model: {
    name: process.env.QVAC_MODEL || "QWEN3_8B_INST_Q4_K_M",
    localPath: process.env.QVAC_MODEL_PATH || "",
    ctxSize: Number(process.env.QVAC_CTX_SIZE || 8192),
    // Cap generated tokens so a rambling small model can't run into a context
    // overflow. Also keeps action-routing snappy. -1 would mean "unbounded".
    maxTokens: Number(process.env.QVAC_MAX_TOKENS || 512),
  },
  hasPimlicoKey: !!pimlicoKey,
  reservoirApiKey,
  reservoirUrl,
};

export function describeConfig() {
  return [
    `network:  ${config.chain.name} (chainId ${config.chain.chainId})`,
    `rpc:      ${config.chain.rpcUrl}`,
    `gas mode: ${config.gasMode}${config.gasMode === "dry-run" ? "  (sends are simulated — set PIMLICO_API_KEY to broadcast)" : ""}`,
    ...(config.chain.dex
      ? [`dex:      ${config.chain.dex.name}  (slippage ${config.slippagePercent}%)`]
      : ["dex:      none (swaps disabled on this network)"]),
    ...(config.isMainnet ? ["warning:  MAINNET — sends move real MON"] : []),
    `account:  #${config.accountIndex}`,
    `model:    ${config.model.localPath || config.model.name}`,
  ].join("\n");
}
