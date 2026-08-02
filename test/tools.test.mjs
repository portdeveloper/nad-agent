/**
 * Unit tests for the NL→action interpreter in src/tools.mjs.
 *
 * Uses node:test + node:assert (built into Node 22). Zero new dependencies.
 * Imports src/tools.mjs directly — no build step, no model needed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ACTIONS, parseAction, isWrite, describeAction, systemPrompt, runAction } from "../src/tools.mjs";
import { config } from "../src/config.mjs";

// ---------------------------------------------------------------------------
// parseAction — JSON path
// ---------------------------------------------------------------------------

describe("parseAction — JSON path", () => {
  it("get_address", () => {
    assert.deepEqual(parseAction('{"action":"get_address"}'), { action: "get_address" });
  });

  it("get_balance", () => {
    assert.deepEqual(parseAction('{"action":"get_balance"}'), { action: "get_balance" });
  });

  it("send_mon with args", () => {
    assert.deepEqual(
      parseAction('{"action":"send_mon","to":"0x1234567890abcdef1234567890abcdef12345678","amountMon":"0.5"}'),
      { action: "send_mon", to: "0x1234567890abcdef1234567890abcdef12345678", amountMon: "0.5" },
    );
  });

  it("none", () => {
    assert.deepEqual(parseAction('{"action":"none"}'), { action: "none" });
  });

  it("JSON after a Qwen3 think block", () => {
    const input = "<think>\nsome reasoning\n</think>\n\n{\"action\":\"get_balance\"}";
    assert.deepEqual(parseAction(input), { action: "get_balance" });
  });

  it("JSON inside prose", () => {
    const input = "Here you go: {\"action\":\"send_mon\",\"to\":\"0x000000000000000000000000000000000000dEaD\",\"amountMon\":\"1\"}";
    assert.deepEqual(parseAction(input), {
      action: "send_mon",
      to: "0x000000000000000000000000000000000000dEaD",
      amountMon: "1",
    });
  });

  it("JSON in a code fence", () => {
    const input = "```json\n{\"action\":\"get_address\"}\n```";
    assert.deepEqual(parseAction(input), { action: "get_address" });
  });

  it("unknown action returns none", () => {
    assert.deepEqual(parseAction('{"action":"swap"}'), { action: "none" });
  });
});

// ---------------------------------------------------------------------------
// parseAction — lenient fallback
// ---------------------------------------------------------------------------

describe("parseAction — lenient fallback (read-only actions only)", () => {
  it("plain-text get_balance()", () => {
    assert.deepEqual(parseAction("get_balance()"), { action: "get_balance" });
  });

  it("plain-text get_address()", () => {
    assert.deepEqual(parseAction("get_address()"), { action: "get_address" });
  });

  // Safety property: writes must NOT auto-trigger from plain text.
  // src/tools.mjs:48-49 — the lenient path is intentionally read-only.
  it("plain-text send_mon(...) does NOT auto-trigger a write", () => {
    assert.deepEqual(
      parseAction("send_mon(0x000000000000000000000000000000000000dEaD, 0.5)"),
      { action: "none" },
    );
  });

  it("empty string → none", () => {
    assert.deepEqual(parseAction(""), { action: "none" });
  });

  it("unrelated prose → none", () => {
    assert.deepEqual(parseAction("the weather is nice today"), { action: "none" });
  });

  it("malformed JSON → none", () => {
    assert.deepEqual(parseAction("{action: unbalanced"), { action: "none" });
  });
});

// ---------------------------------------------------------------------------
// isWrite
// ---------------------------------------------------------------------------

describe("isWrite", () => {
  it("send_mon is a write", () => {
    assert.equal(isWrite("send_mon"), true);
  });

  it("get_balance is not a write", () => {
    assert.equal(isWrite("get_balance"), false);
  });

  it("get_address is not a write", () => {
    assert.equal(isWrite("get_address"), false);
  });

  it("none is not a write", () => {
    assert.equal(isWrite("none"), false);
  });
});

// ---------------------------------------------------------------------------
// systemPrompt covers all ACTIONS keys (no silent drift)
// ---------------------------------------------------------------------------

describe("systemPrompt / ACTIONS invariance", () => {
  it("systemPrompt() mentions every key in ACTIONS", () => {
    const prompt = systemPrompt();
    for (const key of Object.keys(ACTIONS)) {
      assert.ok(prompt.includes(key), `systemPrompt() missing action "${key}"`);
    }
  });

  it("ACTIONS has at least the expected actions", () => {
    const keys = Object.keys(ACTIONS);
    assert.ok(keys.includes("get_address"), "missing get_address in ACTIONS");
    assert.ok(keys.includes("get_balance"), "missing get_balance in ACTIONS");
    assert.ok(keys.includes("send_mon"), "missing send_mon in ACTIONS");
    assert.ok(keys.includes("none"), "missing none in ACTIONS");
  });
});

// ---------------------------------------------------------------------------
// describeAction
// ---------------------------------------------------------------------------

describe("describeAction", () => {
  it("get_address returns a read label", () => {
    assert.equal(describeAction({ action: "get_address" }), "Read: your wallet address");
  });

  it("get_balance returns a read label", () => {
    assert.equal(describeAction({ action: "get_balance" }), "Read: your MON balance");
  });

  it("send_mon gas label matches the resolved config.gasMode", () => {
    const expected =
      config.gasMode === "dry-run" ? "DRY RUN" :
      config.gasMode === "sponsored" ? "gasless" :
      "you pay gas";
    const out = describeAction({ action: "send_mon", to: "0xabc", amountMon: "1" });
    assert.ok(out.includes(expected), `expected "${expected}" in "${out}"`);
  });

  it("unknown action → No on-chain action", () => {
    assert.equal(describeAction({ action: "bogus" }), "No on-chain action");
  });
});

// ---------------------------------------------------------------------------
// runAction — guards
// ---------------------------------------------------------------------------

describe("runAction — guards", () => {
  it("send_mon with invalid to returns refusal, does not throw", async () => {
    const res = await runAction({ action: "send_mon", to: "not-an-address", amountMon: "1" });
    assert.match(res ?? "", /refused/i);
  });

  it("none returns null so the caller falls back to chat", async () => {
    assert.equal(await runAction({ action: "none" }), null);
  });
});
