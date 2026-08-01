import { getAddress } from "ethers";
import { config } from "./config.mjs";
import { isAddress } from "./format.mjs";

// Built-in testnet token entries are from the Monad token-list testnet JSON:
// https://github.com/monad-crypto/token-list/blob/main/tokenlist-testnet.json
// Raw token addresses still work for anything not listed here.
export const KNOWN_TOKENS = {
  testnet: {
    USDC: {
      address: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
      name: "USD Coin",
      decimals: 6,
    },
    WETH: {
      address: "0x45477f4709771331db81944A5E20eF95Bc7BA2D7",
      name: "Wrapped Ether",
      decimals: 18,
    },
    WMON: {
      address: "0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541",
      name: "Wrapped MON",
      decimals: 18,
    },
  },
};

export function listKnownTokenSymbols(network = config.chain.network) {
  return Object.keys(KNOWN_TOKENS[network] ?? {}).sort();
}

export function resolveToken(input, network = config.chain.network) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  if (isAddress(raw)) {
    return {
      address: getAddress(raw),
      source: "address",
    };
  }

  const symbol = raw.toUpperCase();
  const token = KNOWN_TOKENS[network]?.[symbol];
  if (!token) return null;

  return {
    ...token,
    symbol,
    address: getAddress(token.address),
    source: "catalog",
  };
}
