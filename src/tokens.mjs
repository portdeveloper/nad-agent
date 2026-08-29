import { getAddress } from "ethers";
import { config } from "./config.mjs";
import { isAddress } from "./format.mjs";

// Built-in token entries are from the Monad token-list JSON files:
// https://github.com/monad-crypto/token-list/blob/main/tokenlist-testnet.json
// https://github.com/monad-crypto/token-list/blob/main/tokenlist-mainnet.json
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
  mainnet: {
    USDC: {
      address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
      name: "USD Coin",
      decimals: 6,
    },
    WETH: {
      address: "0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242",
      name: "Wrapped Ether",
      decimals: 18,
    },
    WMON: {
      address: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A",
      name: "Wrapped MON",
      decimals: 18,
    },
  },
};

export function listKnownTokenSymbols(network = config.chain.network) {
  return Object.keys(KNOWN_TOKENS[network] ?? {}).sort();
}

export function hasKnownTokenCatalog(network = config.chain.network) {
  return listKnownTokenSymbols(network).length > 0;
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
