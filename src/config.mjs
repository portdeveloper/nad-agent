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
    // DEX for the `swap` action: PuddleSwap, a Uniswap-V2-style DEX deployed on
    // Monad testnet (github.com/portdeveloper/puddleswap). RPC-only — quotes and
    // swaps go straight to the router contract, no API server or key. Addresses
    // verified on-chain (eth_getCode + symbol()/decimals() against the public
    // testnet RPC) before being pinned here.
    dex: {
      name: "PuddleSwap",
      router: "0x430c23895c8D44883526e3E0B09327dAD8766660",
      wrappedNative: "0x97B3070F9Da6C002343862b35E68Bd8e22608943", // WMON
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
    dex: null, // no vetted DEX deployment pinned yet — the swap action refuses here
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

// Slippage tolerance for swaps, in percent. Clamped to (0, 50] like the
// PuddleSwap app clamps it; a nonsense value falls back to the 0.5% default.
const rawSlippage = Number(process.env.SWAP_SLIPPAGE_PERCENT || 0.5);
const slippagePercent = rawSlippage > 0 && rawSlippage <= 50 ? rawSlippage : 0.5;

export const config = {
  chain,
  gasMode,
  sponsorshipPolicyId,
  slippagePercent,
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
    `model:    ${config.model.localPath || config.model.name}`,
  ].join("\n");
}
