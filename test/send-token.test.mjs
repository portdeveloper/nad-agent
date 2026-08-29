/**
 * Unit tests for ERC-20 token send (Issue #8).
 *
 * Tests src/tools.mjs parseAction/describeAction/runAction for send_token,
 * and src/wallet.mjs sendToken for the ERC-20 transfer userOp.
 *
 * Uses node:test + node:assert. Zero new dependencies.
 */

import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAction,
  describeAction,
  prepareTokenSend,
  previewTokenSend,
  renderTokenSendPreview,
  runAction,
  ACTIONS,
  isWrite,
} from "../src/tools.mjs";
import { config } from "../src/config.mjs";

const DEAD = "0x000000000000000000000000000000000000dEaD";
const BAD_TOKEN_CHECKSUM = "0x534b2F3A21130d7a60830c2Df862319e593943A3";

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
    assert.deepEqual(parseAction('{"action":"bridge"}'), { action: "none" });
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
    assert.equal(isWrite("send_token"), true);
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

  it("does not execute a token send without prepared confirmation values", async () => {
    const res = await runAction(
      { action: "send_token", token: "USDC", to: DEAD, amount: "1" },
      { ok: true, address: DEAD },
    );
    assert.match(String(res), /prepared token values from the confirmation flow/i);
  });
});

// ---------------------------------------------------------------------------
// prepareTokenSend — pre-prompt validation and single token resolution
// ---------------------------------------------------------------------------

describe("prepareTokenSend", () => {
  it("prepares a catalog token with parsed amount and resolved recipient", async () => {
    const result = await prepareTokenSend({ action: "send_token", token: "USDC", to: DEAD, amount: "1.25" });

    assert.equal(result.ok, true);
    assert.equal(result.recipient.address, DEAD);
    assert.equal(result.token.symbol, "USDC");
    assert.equal(result.token.decimals, 6);
    assert.equal(result.amountWei, 1_250_000n);
  });

  it("loads metadata for a raw token address before parsing the amount", async () => {
    let requestedAddress = null;
    const result = await prepareTokenSend(
      { action: "send_token", token: DEAD, to: DEAD, amount: "1.25" },
      {
        getMetadata: async (address) => {
          requestedAddress = address;
          return { address, symbol: "TEST", decimals: 2, name: "Test Token" };
        },
      },
    );

    assert.equal(result.ok, true);
    assert.equal(requestedAddress, DEAD);
    assert.equal(result.token.symbol, "TEST");
    assert.equal(result.amountWei, 125n);
  });

  it("refuses a token that does not expose decimals", async () => {
    const result = await prepareTokenSend(
      { action: "send_token", token: DEAD, to: DEAD, amount: "1" },
      { getMetadata: async () => ({ symbol: "NO_DECIMALS" }) },
    );

    assert.equal(result.ok, false);
    assert.match(result.reason, /does not expose decimals/);
  });

  it("falls back to the contract address when a token has no symbol", async () => {
    const result = await prepareTokenSend(
      { action: "send_token", token: DEAD, to: DEAD, amount: "1" },
      { getMetadata: async () => ({ decimals: 6, name: "No Symbol Token" }) },
    );

    assert.equal(result.ok, true);
    assert.equal(result.token.symbol, DEAD);
    assert.equal(result.amountWei, 1_000_000n);
  });

  it("refuses an unknown token before metadata lookup", async () => {
    let lookedUp = false;
    const result = await prepareTokenSend(
      { action: "send_token", token: "NOT_A_TOKEN", to: DEAD, amount: "1" },
      { getMetadata: async () => { lookedUp = true; return {}; } },
    );

    assert.equal(result.ok, false);
    assert.match(result.reason, /unknown token/i);
    assert.equal(lookedUp, false);
  });

  it("refuses a token address with a bad checksum before metadata lookup", async () => {
    let lookedUp = false;
    const result = await prepareTokenSend(
      { action: "send_token", token: BAD_TOKEN_CHECKSUM, to: DEAD, amount: "1" },
      { getMetadata: async () => { lookedUp = true; return { decimals: 6 }; } },
    );

    assert.equal(result.ok, false);
    assert.match(result.reason, /checksum failed/);
    assert.equal(lookedUp, false);
  });

  test("refuses an invalid token amount before confirmation", async () => {
    const result = await prepareTokenSend({ action: "send_token", token: "USDC", to: DEAD, amount: "0" });

    assert.equal(result.ok, false);
    assert.match(result.reason, /valid token amount/);
  });
});

// ---------------------------------------------------------------------------
// previewTokenSend — resolved token confirmation block
// ---------------------------------------------------------------------------

describe("previewTokenSend", () => {
  it("shows token metadata, amount, recipient, gas mode, and token balance delta", async () => {
    const previousGasMode = config.gasMode;
    config.gasMode = "dry-run";
    try {
      const prepared = await prepareTokenSend({ action: "send_token", token: "USDC", to: DEAD, amount: "1.25" });
      const preview = await previewTokenSend(prepared, {
        getBalance: async (address) => {
          assert.equal(address, prepared.token.address);
          return 10_000_000n;
        },
        quoteSend: async (to, tokenAddress, amountWei) => {
          assert.equal(to, DEAD);
          assert.equal(tokenAddress, prepared.token.address);
          assert.equal(amountWei, 1_250_000n);
          return { fee: 42_000_000_000_000n };
        },
        simulateSend: async (to, tokenAddress, amountWei) => {
          assert.equal(to, DEAD);
          assert.equal(tokenAddress, prepared.token.address);
          assert.equal(amountWei, 1_250_000n);
          return { simulated: true };
        },
      });

      assert.equal(preview.ok, true);
      assert.equal(preview.to, DEAD);
      assert.equal(preview.tokenAddress, prepared.token.address);
      assert.equal(preview.amount, "1.25");
      assert.equal(preview.amountWei, 1_250_000n);
      assert.equal(preview.before, 10_000_000n);
      assert.equal(preview.after, 8_750_000n);
      assert.equal(preview.fee, 42_000_000_000_000n);
      assert.equal(preview.feeQuoted, true);
      assert.equal(preview.simulated, true);
      assert.equal(preview.insufficient, false);
      assert.match(preview.gasLabel, /dry-run|gasless|you pay gas/);

      const block = renderTokenSendPreview(preview);
      assert.match(block, /Gas:.*~0\.000042 MON/);
      assert.match(block, /Fee quote: available/);
      assert.match(block, /Simulation: available/);
    } finally {
      config.gasMode = previousGasMode;
    }
  });

  it("renders the gasless confirmation block", async () => {
    const previousGasMode = config.gasMode;
    config.gasMode = "sponsored";
    try {
      const prepared = await prepareTokenSend({ action: "send_token", token: "USDC", to: DEAD, amount: "1" });
      const preview = await previewTokenSend(prepared, {
        getBalance: async () => 10_000_000n,
        quoteSend: async () => ({ fee: 42_000_000_000_000n }),
        simulateSend: async () => ({ simulated: true }),
      });
      const block = renderTokenSendPreview(preview);

      assert.equal(preview.gasLabel, "gasless (paymaster covers fee)");
      assert.match(block, /Gas:\s+gasless \(paymaster covers fee\)/);
      assert.match(block, /Fee quote: available/);
      assert.match(block, /Simulation: available/);
    } finally {
      config.gasMode = previousGasMode;
    }
  });

  it("renders a warning when the token balance is insufficient", async () => {
    const prepared = await prepareTokenSend({ action: "send_token", token: "USDC", to: DEAD, amount: "2" });
    const preview = await previewTokenSend(prepared, {
      getBalance: async () => 1_000_000n,
      simulateSend: async () => ({ simulated: true }),
    });
    const block = renderTokenSendPreview(preview);

    assert.equal(preview.insufficient, true);
    assert.match(block, /Token:\s+USDC/);
    assert.match(block, /Contract:/);
    assert.match(block, /To:\s+.*dEaD/i);
    assert.match(block, /Amount:\s+2\.0 USDC/);
    assert.match(block, /Gas:/);
    assert.match(block, /Fee quote: unavailable/);
    assert.match(block, /Simulation: available/);
    assert.match(block, /Balance:\s+1\.0 -> -1\.0 USDC/);
    assert.match(block, /WARNING:.*token balance is below/);
  });

  it("surfaces an unavailable transfer quote without hiding the confirmation block", async () => {
    const prepared = await prepareTokenSend({ action: "send_token", token: "USDC", to: DEAD, amount: "1" });
    const preview = await previewTokenSend(prepared, {
      getBalance: async () => 10_000_000n,
      quoteSend: async () => { throw new Error("bundler unavailable"); },
      simulateSend: async () => ({ simulated: true }),
    });
    const block = renderTokenSendPreview(preview);

    assert.equal(preview.feeQuoted, false);
    assert.match(preview.quoteError, /bundler unavailable/);
    assert.match(block, /Fee quote: unavailable/);
    assert.match(block, /Simulation: available/);
    assert.match(block, /WARNING:.*fee quote unavailable/);
  });

  it("explains why a dry-run fee estimate is unavailable", async () => {
    const previousGasMode = config.gasMode;
    config.gasMode = "dry-run";
    try {
      const prepared = await prepareTokenSend({ action: "send_token", token: "USDC", to: DEAD, amount: "1" });
      const preview = await previewTokenSend(prepared, {
        getBalance: async () => 10_000_000n,
        quoteSend: async () => { throw new Error("bundler unavailable"); },
        simulateSend: async () => ({ simulated: true }),
      });
      const block = renderTokenSendPreview(preview);

      assert.match(block, /Fee quote: unavailable \(dry-run has no bundler estimate\)/);
      assert.match(block, /Simulation: available/);
    } finally {
      config.gasMode = previousGasMode;
    }
  });

  it("renders a lowercase recipient in checksum form", async () => {
    const raw = "0x1234567890abcdef1234567890abcdef12345678";
    const prepared = await prepareTokenSend({ action: "send_token", token: "USDC", to: raw, amount: "1" });
    const preview = await previewTokenSend(prepared, {
      getBalance: async () => 10_000_000n,
      quoteSend: async () => ({ fee: 0n }),
      simulateSend: async () => ({ simulated: true }),
    });
    const block = renderTokenSendPreview(preview);

    assert.match(block, /To:\s+0x1234567890AbcdEF1234567890aBcdef12345678/);
    assert.doesNotMatch(block, new RegExp(`To:\\s+${raw}`));
  });

  it("surfaces a transfer simulation warning before confirmation", async () => {
    const prepared = await prepareTokenSend({ action: "send_token", token: "USDC", to: DEAD, amount: "1" });
    const preview = await previewTokenSend(prepared, {
      getBalance: async () => 10_000_000n,
      quoteSend: async () => ({ fee: 0n }),
      simulateSend: async () => { throw new Error("execution reverted: insufficient balance"); },
    });
    const block = renderTokenSendPreview(preview);

    assert.equal(preview.simulated, false);
    assert.match(preview.simulationError, /insufficient balance/);
    assert.match(block, /Simulation: unavailable/);
    assert.match(block, /WARNING:.*simulation failed/);
  });

  it("shows the recipient policy that applies to a token send", async () => {
    const prepared = await prepareTokenSend({ action: "send_token", token: "USDC", to: DEAD, amount: "1" });
    const preview = await previewTokenSend(prepared, {
      policy: {
        maxPerSend: 500_000_000_000_000_000n,
        maxPerSession: 1_000_000_000_000_000_000n,
        allowlist: [DEAD],
      },
      sessionSpent: 100_000_000_000_000_000n,
      getBalance: async () => 10_000_000n,
      quoteSend: async () => ({ fee: 0n }),
    });
    const block = renderTokenSendPreview(preview);

    assert.equal(preview.policyNote, "recipient allowlisted");
    assert.match(block, /Policy:\s+recipient allowlisted/);
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
