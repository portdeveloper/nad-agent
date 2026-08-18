/**
 * Unit tests for multi-account feature (Issue #12).
 *
 * Covers: config.accountIndex, ACTIONS.account, parseAction, describeAction,
 * and systemPrompt coverage. Wallet-level switch/list are integration-tested
 * via npm run smoke (no WDK in CI).
 *
 * Uses node:test + node:assert. Zero new dependencies.
 */

import { describe, it, test, after, before } from "node:test";
import assert from "node:assert/strict";
import { config, getAccountIndex, setAccountIndex } from "../src/config.mjs";
import { ACTIONS, parseAction, describeAction, systemPrompt, runAction } from "../src/tools.mjs";
import { validateAccountIndex } from "../src/wallet.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";

// Use an isolated temp directory so tests never touch ~/.nad-agent/state.json.
const TEST_STATE_DIR = join(tmpdir(), `nad-agent-test-${process.pid}`);
const TEST_STATE_PATH = join(TEST_STATE_DIR, "state.json");
const REAL_STATE_PATH = process.env.NAD_STATE_PATH; // saved for restore

before(() => {
  mkdirSync(TEST_STATE_DIR, { recursive: true });
  process.env.NAD_STATE_PATH = TEST_STATE_PATH;
});

after(async () => {
  // Clear the override so production code uses ~/.nad-agent again.
  if (REAL_STATE_PATH === undefined) {
    delete process.env.NAD_STATE_PATH;
  } else {
    process.env.NAD_STATE_PATH = REAL_STATE_PATH;
  }
  // Clean up temp files.
  try { rmSync(TEST_STATE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// config.accountIndex
// ---------------------------------------------------------------------------

describe("config — accountIndex", () => {
  it("defaults to 0 (v0 behavior preserved)", () => {
    assert.equal(config.accountIndex, 0);
  });

  it("is a non-negative integer", () => {
    assert.ok(Number.isInteger(config.accountIndex), "accountIndex must be integer");
    assert.ok(config.accountIndex >= 0, "accountIndex must be >= 0");
  });
});

// ---------------------------------------------------------------------------
// ACTIONS shape — account action
// ---------------------------------------------------------------------------

describe("ACTIONS — account", () => {
  it("account action exists", () => {
    assert.ok("account" in ACTIONS, "account should be an action");
  });

  it("account args are [index]", () => {
    assert.deepEqual(ACTIONS.account.args, ["index"]);
  });

  it("account has a description", () => {
    assert.ok(ACTIONS.account.desc && ACTIONS.account.desc.length > 0);
  });
});

// ---------------------------------------------------------------------------
// parseAction — account
// ---------------------------------------------------------------------------

describe("parseAction — account", () => {
  it("parses account action with no args (list)", () => {
    assert.deepEqual(parseAction('{"action":"account"}'), { action: "account" });
  });

  it("parses account action with string index", () => {
    assert.deepEqual(
      parseAction('{"action":"account","index":"2"}'),
      { action: "account", index: "2" },
    );
  });

  it("parses account action with number index", () => {
    assert.deepEqual(
      parseAction('{"action":"account","index":1}'),
      { action: "account", index: 1 },
    );
  });

  it("lenient fallback does NOT auto-trigger account from plain text", () => {
    assert.deepEqual(parseAction("switch to account 1"), { action: "none" });
  });

  it("lenient fallback does NOT auto-trigger from pseudo-function call", () => {
    assert.deepEqual(parseAction("account(1)"), { action: "none" });
  });
});

// ---------------------------------------------------------------------------
// describeAction — account
// ---------------------------------------------------------------------------

describe("describeAction — account", () => {
  it("describes account list (no index)", () => {
    const out = describeAction({ action: "account" });
    assert.ok(out.toLowerCase().includes("account"), `expected "account" in "${out}"`);
  });

  it("describes account switch (with index)", () => {
    const out = describeAction({ action: "account", index: "2" });
    assert.ok(out.includes("2"), `expected index "2" in "${out}"`);
  });

  it("unknown action → No on-chain action", () => {
    assert.equal(describeAction({ action: "bogus" }), "No on-chain action");
  });
});

// ---------------------------------------------------------------------------
// systemPrompt includes account
// ---------------------------------------------------------------------------

describe("systemPrompt — account coverage", () => {
  it("systemPrompt mentions the account action", () => {
    assert.ok(systemPrompt().includes("account"), "systemPrompt should mention account action");
  });

  it("systemPrompt mentions every key in ACTIONS", () => {
    const prompt = systemPrompt();
    for (const key of Object.keys(ACTIONS)) {
      assert.ok(prompt.includes(key), `systemPrompt() missing action "${key}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// validateAccountIndex — guard for initWallet and switchAccount
// ---------------------------------------------------------------------------

describe("validateAccountIndex", () => {
  it("accepts 0", () => {
    assert.doesNotThrow(() => validateAccountIndex(0));
  });

  it("accepts positive integers", () => {
    assert.doesNotThrow(() => validateAccountIndex(42));
  });

  it("rejects negative numbers", () => {
    assert.throws(() => validateAccountIndex(-1), /non-negative/);
  });

  it("rejects NaN", () => {
    assert.throws(() => validateAccountIndex(NaN), /non-negative/);
  });

  it("rejects non-integers", () => {
    assert.throws(() => validateAccountIndex(1.5), /non-negative/);
  });

  it("rejects non-numbers", () => {
    assert.throws(() => validateAccountIndex("abc"), /non-negative/);
  });
});

// ---------------------------------------------------------------------------
// runAction — account integration
// ---------------------------------------------------------------------------

describe("runAction — account", () => {
  it("account list throws when wallet is not initialized", async () => {
    let threw = false;
    try {
      // Pass a resolved recipient to satisfy the isWrite guard; listAccounts
      // should then throw "Wallet not initialized" from wallet.mjs.
      await runAction(
        { action: "account" },
        { ok: true, address: "0x1111111111111111111111111111111111111111", name: null },
      );
    } catch (e) {
      threw = true;
      assert.ok(String(e.message).toLowerCase().includes("not initialized"));
    }
    assert.ok(threw, "should throw when wallet not initialized");
  });

  it("account switch with invalid index returns refusal", async () => {
    const res = await runAction({ action: "account", index: "-1" });
    assert.match(String(res), /refused/i);
  });

  it("account switch with non-integer returns refusal", async () => {
    const res = await runAction({ action: "account", index: "abc" });
    assert.match(String(res), /refused/i);
  });

  it("account switch with boolean index returns refusal", async () => {
    const res = await runAction({ action: "account", index: true });
    assert.match(String(res), /refused/i);
  });

  it("account switch with false index returns refusal", async () => {
    const res = await runAction({ action: "account", index: false });
    assert.match(String(res), /refused/i);
  });

  it("refusal message sanitizes embedded control characters", async () => {
    const res = await runAction({ action: "account", index: "\x1b[31mabc\x1b[0m" });
    assert.match(String(res), /refused/i);
    assert.ok(!res.includes("\x1b"), "refusal should not contain raw ANSI escape sequences");
  });

  it("rejects index as a floating-point string with fractional part", async () => {
    const res = await runAction({ action: "account", index: "2.5" });
    assert.match(String(res), /refused/i);
  });
});

// ---------------------------------------------------------------------------
// ACTIONS invariance — account present alongside existing actions
// ---------------------------------------------------------------------------

describe("ACTIONS — required keys still present", () => {
  const required = ["get_address", "get_balance", "get_token_balance", "send_mon", "send_token", "none"];
  for (const key of required) {
    it(`has ${key}`, () => {
      assert.ok(key in ACTIONS, `missing ${key} in ACTIONS`);
    });
  }
});

// ---------------------------------------------------------------------------
// Persistence: setAccountIndex writes to isolated test state file
// ---------------------------------------------------------------------------

describe("persistence — setAccountIndex", () => {
  const originalIndex = getAccountIndex();

  after(async () => {
    await setAccountIndex(originalIndex);
  });

  it("writes account index to the state file", async () => {
    await setAccountIndex(3);
    const { readFileSync } = await import("node:fs");
    const content = JSON.parse(readFileSync(TEST_STATE_PATH, "utf8"));
    assert.equal(content.accountIndex, 3);
  });

  it("round-trips across a fresh module import (getAccountIndex)", async () => {
    await setAccountIndex(7);
    const result = execSync(
      `NAD_STATE_PATH="${TEST_STATE_PATH}" node --input-type=module -e 'import { getAccountIndex } from "./src/config.mjs"; console.log(getAccountIndex())'`,
      { cwd: process.cwd(), encoding: "utf8" },
    ).trim();
    assert.equal(result, "7", "fresh process should read persisted index");
  });

  it("config.accountIndex getter reflects the persisted value", async () => {
    await setAccountIndex(4);
    assert.equal(config.accountIndex, 4, "getter should return current index");
  });

  it("writeState merges with existing keys (does not overwrite)", async () => {
    // Write a key, then write another key — both should coexist.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(TEST_STATE_PATH, JSON.stringify({ accountIndex: 1, _futureKey: "hello" }));
    await setAccountIndex(2);
    const content = JSON.parse(
      (await import("node:fs")).readFileSync(TEST_STATE_PATH, "utf8"),
    );
    assert.equal(content.accountIndex, 2, "accountIndex should be updated");
    assert.equal(content._futureKey, "hello", "existing keys should be preserved");
  });

  it("handles corrupted state.json (garbage JSON) by falling back to default", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(TEST_STATE_PATH, "NOT JSON{{{[");
    // Re-import config module to trigger readState with bad file.
    const result = execSync(
      `NAD_STATE_PATH="${TEST_STATE_PATH}" node --input-type=module -e 'import { getAccountIndex } from "./src/config.mjs"; console.log(getAccountIndex())'`,
      { cwd: process.cwd(), encoding: "utf8" },
    ).trim();
    assert.equal(result, "0", "corrupted state.json should fall back to default (0)");
  });

  it("silently ignores setAccountIndex with negative number", async () => {
    await setAccountIndex(3); // set a valid value first
    await setAccountIndex(-1); // try to set invalid
    const { readFileSync } = await import("node:fs");
    const content = JSON.parse(readFileSync(TEST_STATE_PATH, "utf8"));
    assert.equal(content.accountIndex, 3, "negative index should be ignored");
  });

  it("silently ignores setAccountIndex with float", async () => {
    await setAccountIndex(3);
    await setAccountIndex(2.5);
    const { readFileSync } = await import("node:fs");
    const content = JSON.parse(readFileSync(TEST_STATE_PATH, "utf8"));
    assert.equal(content.accountIndex, 3, "float index should be ignored");
  });

  it("silently ignores setAccountIndex above upper bound", async () => {
    await setAccountIndex(3);
    await setAccountIndex(1000);
    const { readFileSync } = await import("node:fs");
    const content = JSON.parse(readFileSync(TEST_STATE_PATH, "utf8"));
    assert.equal(content.accountIndex, 3, "out-of-range index should be ignored");
  });

  it("does not update in-memory state when disk write fails", async () => {
    const blockerDir = join(TEST_STATE_DIR, "test-blocker-write");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(blockerDir, "x");
    const badPath = join(blockerDir, "state.json");
    const saved = process.env.NAD_STATE_PATH;
    process.env.NAD_STATE_PATH = badPath;
    const before = getAccountIndex();
    let threw = false;
    try {
      await setAccountIndex(5);
    } catch {
      threw = true;
    }
    assert.ok(threw, "write failure should propagate");
    assert.equal(getAccountIndex(), before, "in-memory index must not change when disk write fails");
    process.env.NAD_STATE_PATH = saved;
  });
});
