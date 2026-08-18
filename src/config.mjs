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
  },
  mainnet: {
    chainId: 143,
    name: "Monad Mainnet",
    rpcUrl: "https://rpc.monad.xyz",
    explorerUrl: "https://monadscan.com",
    symbol: "MON",
  },
};

const network = process.env.MONAD_NETWORK === "mainnet" ? "mainnet" : "testnet";
const chain = { network, ...NETWORKS[network] };
if (process.env.MONAD_RPC_URL) chain.rpcUrl = process.env.MONAD_RPC_URL;

const pimlicoKey = process.env.PIMLICO_API_KEY || "";
const sponsorshipPolicyId = process.env.PIMLICO_SPONSORSHIP_POLICY_ID || "";
const gasOverride = (process.env.WDK_GAS_MODE || "").toLowerCase();

// Resolve the effective gas mode:
//   dry-run   -> simulate sends (no bundler needed). Auto-selected when no Pimlico key.
//   sponsored -> gasless via Pimlico paymaster (agent pays 0)
//   native    -> you-pay-gas in MON (still needs a bundler = Pimlico key)
let gasMode;
if (gasOverride === "dry-run" || !pimlicoKey) gasMode = "dry-run";
else if (gasOverride === "native") gasMode = "native";
else gasMode = "sponsored";

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

export const config = {
  chain,
  // Convenience flag for guardrails: mainnet moves real funds.
  isMainnet: network === "mainnet",
  gasMode,
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
  model: {
    name: process.env.QVAC_MODEL || "QWEN3_8B_INST_Q4_K_M",
    localPath: process.env.QVAC_MODEL_PATH || "",
    ctxSize: Number(process.env.QVAC_CTX_SIZE || 8192),
    // Cap generated tokens so a rambling small model can't run into a context
    // overflow. Also keeps action-routing snappy. -1 would mean "unbounded".
    maxTokens: Number(process.env.QVAC_MAX_TOKENS || 256),
  },
  hasPimlicoKey: !!pimlicoKey,
};

export function describeConfig() {
  return [
    `network:  ${config.chain.name} (chainId ${config.chain.chainId})`,
    `rpc:      ${config.chain.rpcUrl}`,
    `gas mode: ${config.gasMode}${config.gasMode === "dry-run" ? "  (sends are simulated — set PIMLICO_API_KEY to broadcast)" : ""}`,
    ...(config.isMainnet ? ["warning:  MAINNET — sends move real MON"] : []),
    `account:  #${config.accountIndex}`,
    `model:    ${config.model.localPath || config.model.name}`,
  ].join("\n");
}
