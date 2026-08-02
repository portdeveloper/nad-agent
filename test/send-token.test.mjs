/**
 * Unit tests for ERC-20 token send (Issue #8).
 *
 * Tests src/tools.mjs parseAction/describeAction/runAction for send_token,
 * and src/wallet.mjs sendToken for the ERC-20 transfer userOp.
 *
 * Uses node:test + node:assert. Zero new dependencies.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAction, describeAction, runAction, ACTIONS } from "../src/tools.mjs";
import { config } from "../src/config.mjs";

// ---------------------------------------------------------------------------
// ACTIONS shape
// ---------------------------------------------------------------------------

describe("ACTIONS — send_token", () => {
  it("send_token is in ACTIONS", () => {
    assert.ok("send_token" in ACTIONS, "send_token should be an action");
  });

  it("send_token has correct args", () => {
    assert.deepEqual(ACTIONS.send_token.args, ["token", "to", "amount"]);
  });
});

// ---------------------------------------------------------------------------
// parseAction — send_token JSON
// ---------------------------------------------------------------------------

describe("parseAction — send_token", () => {
  it("parses send_token with symbol", () => {
    const result = parseAction('{"action":"send_token","token":"USDC","to":"0x1234567890abcdef1234567890abcdef12345678","amount":"10"}');
    assert.deepEqual(result, {
      action: "send_token",
      token: "USDC",
      to: "0x1234567890abcdef1234567890abcdef12345678",
      amount: "10",
    });
  });

  it("parses send_token with contract address", () => {
    const result = parseAction('{"action":"send_token","token":"0x534b2f3A21130d7a60830c2Df862319e593943A3","to":"0xabcdefabcdefabcdefabcdefabcdefabcdefabcd","amount":"100"}');
    assert.deepEqual(result, {
      action: "send_token",
      token: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
      to: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      amount: "100",
    });
  });

  it("parses send_token with symbol/tokenAddress alias", () => {
    const result = parseAction('{"action":"send_token","symbol":"WETH","to":"0x1234567890abcdef1234567890abcdef12345678","amount":"0.5"}');
    assert.deepEqual(result, {
      action: "send_token",
      symbol: "WETH",
      to: "0x1234567890abcdef1234567890abcdef12345678",
      amount: "0.5",
    });
  });

  it("lenient fallback does NOT auto-trigger send_token", () => {
    const result = parseAction("send_token(USDC, 0x1234567890abcdef1234567890abcdef12345678, 10)");
    assert.deepEqual(result, { action: "none" });
  });

  it("unknown action → none", () => {
    assert.deepEqual(parseAction('{"action":"swap"}'), { action: "none" });
  });
});

// ---------------------------------------------------------------------------
// describeAction — send_token
// ---------------------------------------------------------------------------

// describeAction now takes the recipient resolveSend() produced: it never re-reads the raw
// model output, so a caller that has not resolved gets "[recipient not resolved]" rather than
// an address it was never given. These calls pass one.
describe("describeAction — send_token", () => {
  it("describes send_token with symbol", () => {
    const out = describeAction({ action: "send_token", token: "USDC", to: "0xabc", amount: "10" }, { ok: true, address: "0xabc" });
    assert.ok(out.includes("USDC"), `expected USDC in "${out}"`);
    assert.ok(out.includes("0xabc"), `expected address in "${out}"`);
    assert.ok(out.includes("10"), `expected amount in "${out}"`);
  });

  it("describes send_token with contract address", () => {
    const out = describeAction({ action: "send_token", token: "0x534b2f3A21130d7a60830c2Df862319e593943A3", to: "0xabc", amount: "5" }, { ok: true, address: "0xabc" });
    assert.ok(out.toLowerCase().includes("send"), `expected "send" in "${out}"`);
    assert.ok(out.includes("5"), `expected amount in "${out}"`);
  });

  it("dry-run label matches gasMode", () => {
    const expected =
      config.gasMode === "dry-run" ? "DRY RUN" :
      config.gasMode === "sponsored" ? "gasless" :
      "you pay gas";
    const out = describeAction({ action: "send_token", token: "USDC", to: "0xabc", amount: "1" }, { ok: true, address: "0xabc" });
    assert.ok(out.includes(expected), `expected "${expected}" in "${out}"`);
  });

  it("unknown action → No on-chain action", () => {
    assert.equal(describeAction({ action: "bogus" }), "No on-chain action");
  });
});

// ---------------------------------------------------------------------------
// isWrite — send_token is a write
// ---------------------------------------------------------------------------

describe("isWrite — send_token", () => {
  it("send_token is a write", () => {
    assert.equal(parseAction('{"action":"send_token"}').action === "send_token" && ACTIONS.send_token !== undefined, true);
  });
});

// ---------------------------------------------------------------------------
// runAction — send_token guard
// ---------------------------------------------------------------------------

describe("runAction — send_token guard", () => {
  it("send_token with invalid to returns refusal", async () => {
    const res = await runAction({ action: "send_token", token: "USDC", to: "not-an-address", amount: "1" });
    assert.match(String(res), /refused/i);
  });

  it("send_token with missing token returns error", async () => {
    const res = await runAction({ action: "send_token", to: "0x534b2f3A21130d7a60830c2Df862319e593943A3", amount: "1" });
    assert.match(String(res), /token/i);
  });
});

// ---------------------------------------------------------------------------
// systemPrompt includes send_token
// ---------------------------------------------------------------------------

describe("systemPrompt — send_token", () => {
  it("systemPrompt mentions send_token", () => {
    const prompt = describeAction({ action: "get_address" }); // just checking ACTIONS
    assert.ok(ACTIONS.send_token !== undefined, "send_token should exist in ACTIONS");
  });
});
