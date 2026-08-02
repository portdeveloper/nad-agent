/**
 * Env-driven configuration. This is the ONLY file that differs in behavior
 * between machines — and it does so purely by reading environment variables.
 * The same built code runs on this Linux dev box (tiny CPU model, dry-run) and
 * on an M4 Max (big Metal model, real gasless sends).
 *
 * Monad is EVM-equivalent, so WDK's ERC-4337 modules work by pointing `provider`
 * at a Monad RPC + chainId — values from docs.monad.xyz.
 */

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
    `model:    ${config.model.localPath || config.model.name}`,
  ].join("\n");
}
