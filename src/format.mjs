/** MON <-> wei helpers. Monad uses 18 decimals like ETH, so ethers' parse/format work. */
import { parseEther, formatEther, formatUnits } from "ethers";

export const parseMon = (amount) => parseEther(String(amount));
export const formatMon = (wei) => formatEther(wei);
export const formatTokenUnits = (amount, decimals) => formatUnits(amount, decimals);

/** Loose but useful EVM address check for confirming send targets. */
export const isAddress = (s) => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s.trim());
