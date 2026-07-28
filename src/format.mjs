/** MON <-> wei helpers. Monad uses 18 decimals like ETH, so ethers' parse/format work. */
import { parseEther, formatEther, parseUnits, formatUnits } from "ethers";

export const parseMon = (amount) => parseEther(String(amount));
export const formatMon = (wei) => formatEther(wei);

/** Token amount helpers for arbitrary ERC-20 decimals (USDC is 6, WMON is 18). */
export const parseAmount = (amount, decimals) => parseUnits(String(amount), decimals);
export const formatAmount = (raw, decimals) => formatUnits(raw, decimals);

/** Loose but useful EVM address check for confirming send targets. */
export const isAddress = (s) => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s.trim());
