import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAction,
  isWrite,
  ACTIONS,
  systemPrompt,
  describeAction,
  runAction,
  resolveToken,
  knownTokenSymbols,
  KNOWN_TOKENS,
} from "../src/tools.mjs";
import { parseTokenAmount } from "../src/format.mjs";

const ADDR = "0xabcdef1234567890abcdef1234567890abcdef12";

// ── resolveToken ────────────────────────────────────────────────────────────
test("resolveToken: known testnet symbol, case-insensitive", () => {
  const t = resolveToken("usdc", "testnet");
  assert.equal(t.symbol, "USDC");
  assert.equal(t.address, KNOWN_TOKENS.testnet.USDC);
});

test("resolveToken: raw 0x address passes through", () => {
  const t = resolveToken(ADDR, "testnet");
  assert.equal(t.address, ADDR);
  assert.equal(t.symbol, undefined);
});

test("resolveToken: unknown symbol returns null", () => {
  assert.equal(resolveToken("NOPE", "testnet"), null);
});

test("resolveToken: empty/undefined input returns null", () => {
  assert.equal(resolveToken("", "testnet"), null);
  assert.equal(resolveToken(undefined, "testnet"), null);
});

test("resolveToken: symbols are network-scoped", () => {
  // USDT0 exists on mainnet's list only
  assert.equal(resolveToken("USDT0", "testnet"), null);
  assert.ok(resolveToken("USDT0", "mainnet"));
});

test("knownTokenSymbols lists the network's built-ins", () => {
  assert.deepEqual(knownTokenSymbols("testnet").sort(), ["USDC", "WETH", "WMON"]);
});

// ── amount scaling ──────────────────────────────────────────────────────────
test("parseTokenAmount scales by the token's decimals", () => {
  assert.equal(parseTokenAmount("1.5", 6), 1500000n);
  assert.equal(parseTokenAmount("1", 18), 10n ** 18n);
});

test("parseTokenAmount rejects too many decimal places", () => {
  assert.throws(() => parseTokenAmount("0.0000001", 6));
});

// ── action protocol ─────────────────────────────────────────────────────────
test("ACTIONS includes send_token with token/to/amount args", () => {
  assert.deepEqual(ACTIONS.send_token.args, ["token", "to", "amount"]);
});

test("systemPrompt mentions send_token and the known symbols", () => {
  const p = systemPrompt();
  assert.match(p, /send_token/);
  assert.match(p, /USDC/);
});

test("parseAction: JSON send_token with args", () => {
  const r = parseAction(`{"action":"send_token","token":"USDC","to":"${ADDR}","amount":"5"}`);
  assert.equal(r.action, "send_token");
  assert.equal(r.token, "USDC");
  assert.equal(r.amount, "5");
});

test("isWrite: send_token requires confirmation", () => {
  assert.equal(isWrite("send_token"), true);
});

test("parseAction: lenient path never triggers send_token", () => {
  assert.equal(parseAction(`send_token(USDC, ${ADDR}, 5)`).action, "none");
});

test("describeAction: send_token preview shows amount, symbol and recipient", () => {
  const d = describeAction({ action: "send_token", token: "usdc", to: ADDR, amount: "5" });
  assert.match(d, /Send 5 USDC \(ERC-20\) -> 0xabcdef/);
});

// ── refusal paths (no network, no wallet) ───────────────────────────────────
test("runAction: send_token refuses a bad recipient", async () => {
  const out = await runAction({ action: "send_token", token: "USDC", to: "not-an-address", amount: "5" });
  assert.match(out, /Refused:.*not a valid address/);
});

test("runAction: send_token refuses an unknown token symbol", async () => {
  const out = await runAction({ action: "send_token", token: "NOPE", to: ADDR, amount: "5" });
  assert.match(out, /Refused: unknown token/);
  assert.match(out, /USDC/); // suggests the known symbols
});
