import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy, checkPolicy, checkSwapPolicy, hasRules, describePolicy, describeSwapPolicy } from "../src/policy.mjs";
import { resolveSend } from "../src/tools.mjs";
import { parseMon } from "../src/format.mjs";

const ALICE = "0x92936497B6ad2BA84b3f7Af22C9afF15f00b13B5";
const BOB = "0x000000000000000000000000000000000000dEaD";

function policyFile(contents) {
  const dir = mkdtempSync(join(tmpdir(), "nad-policy-"));
  const path = join(dir, "policy.json");
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  return path;
}

describe("loadPolicy", () => {
  test("returns null when the file does not exist", () => {
    assert.equal(loadPolicy(join(tmpdir(), "nad-policy-missing", "policy.json")), null);
  });

  test("parses amounts into wei and checksums the allowlist", () => {
    const p = loadPolicy(policyFile({ maxPerSend: "0.5", maxPerSession: "2", allowlist: [ALICE.toLowerCase()] }));
    assert.equal(p.maxPerSend, parseMon("0.5"));
    assert.equal(p.maxPerSession, parseMon("2"));
    assert.deepEqual(p.allowlist, [ALICE]);
  });

  test("fails closed on malformed JSON", () => {
    assert.throws(() => loadPolicy(policyFile("{ not json")), /not valid JSON/);
  });

  test("fails closed on a bad allowlist entry", () => {
    assert.throws(() => loadPolicy(policyFile({ allowlist: ["alice"] })), /not a valid address/);
  });

  test("rejects a non-positive limit", () => {
    assert.throws(() => loadPolicy(policyFile({ maxPerSend: "0" })), /greater than zero/);
  });

  test("rejects unknown keys so a typo cannot silently disable enforcement", () => {
    assert.throws(() => loadPolicy(policyFile({ max_per_send: "1" })), /unknown key.*max_per_send/);
    assert.throws(() => loadPolicy(policyFile({ allowList: ["0x" + "a".repeat(40)] })), /unknown key.*allowList/);
  });
});

describe("checkPolicy", () => {
  const rules = loadPolicy(policyFile({ maxPerSend: "0.5", maxPerSession: "1", allowlist: [ALICE] }));

  test("no policy allows everything", () => {
    assert.equal(checkPolicy(null, { to: BOB, value: parseMon("100") }).ok, true);
    assert.equal(hasRules(null), false);
  });

  test("allows a send inside every rule", () => {
    assert.equal(checkPolicy(rules, { to: ALICE, value: parseMon("0.4") }).ok, true);
  });

  test("refuses a recipient outside the allowlist", () => {
    const v = checkPolicy(rules, { to: BOB, value: parseMon("0.1") });
    assert.equal(v.ok, false);
    assert.equal(v.rule, "allowlist");
  });

  test("refuses an amount above the per-send limit", () => {
    const v = checkPolicy(rules, { to: ALICE, value: parseMon("0.6") });
    assert.equal(v.ok, false);
    assert.equal(v.rule, "maxPerSend");
  });

  test("refuses once the session budget is exhausted", () => {
    const v = checkPolicy(rules, { to: ALICE, value: parseMon("0.4"), sessionSpent: parseMon("0.8") });
    assert.equal(v.ok, false);
    assert.equal(v.rule, "maxPerSession");
    assert.match(v.message, /0\.2 MON left/);
  });

  test("a token send is refused for a non-allowlisted recipient", () => {
    // Token amounts are not denominated in MON, so they arrive with value null.
    // The recipient rule must still bind, or token transfers bypass the policy.
    const v = checkPolicy(rules, { to: BOB, value: null });
    assert.equal(v.ok, false);
    assert.equal(v.rule, "allowlist");
  });

  test("a lowercase recipient matches its checksummed allowlist entry", () => {
    const v = checkPolicy(rules, { to: ALICE.toLowerCase(), value: parseMon("0.1") });
    assert.equal(v.ok, true);
  });

  test("a token send to an allowlisted recipient passes, ignoring the MON limits", () => {
    // maxPerSend is 0.5 MON; a token send carries no MON amount, so the amount
    // rules must not fire on it.
    assert.equal(checkPolicy(rules, { to: ALICE, value: null }).ok, true);
    assert.equal(checkPolicy(rules, { to: ALICE, value: null, sessionSpent: parseMon("999") }).ok, true);
  });

  test("the session budget accumulates rather than resetting per send", () => {
    const first = checkPolicy(rules, { to: ALICE, value: parseMon("0.5"), sessionSpent: 0n });
    const second = checkPolicy(rules, { to: ALICE, value: parseMon("0.5"), sessionSpent: parseMon("0.5") });
    const third = checkPolicy(rules, { to: ALICE, value: parseMon("0.5"), sessionSpent: parseMon("1") });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(third.ok, false);
  });
});

describe("describePolicy", () => {
  test("is silent without rules", () => {
    assert.equal(describePolicy(null, { value: parseMon("1") }), null);
  });

  test("reports the session budget usage", () => {
    const p = loadPolicy(policyFile({ maxPerSession: "10" }));
    assert.equal(describePolicy(p, { value: parseMon("2.5"), sessionSpent: 0n }), "2.5 of 10.0 MON session budget");
  });
});

describe("resolveSend enforces the policy on every write action", () => {
  const path = policyFile({ maxPerSend: "0.5", allowlist: [ALICE] });
  const prev = process.env.NAD_POLICY;
  const rules = loadPolicy(path);
  after(() => { if (prev === undefined) delete process.env.NAD_POLICY; else process.env.NAD_POLICY = prev; });

  test("refuses a TOKEN send to a recipient outside the allowlist", () => {
    // The hole this closes: the policy used to be reached only inside the
    // native preview path, so send_token bypassed the allowlist entirely.
    const r = resolveSend({ action: "send_token", to: BOB, token: "USDC", amount: "5" }, { policy: rules });
    assert.equal(r.ok, false);
    assert.match(r.reason, /^policy allowlist:/);
  });

  test("allows a TOKEN send to an allowlisted recipient and ignores the MON limit", () => {
    const r = resolveSend({ action: "send_token", to: ALICE, token: "USDC", amount: "5" }, { policy: rules });
    assert.equal(r.ok, true);
    assert.equal(r.recipient.address, ALICE);
  });

  test("still refuses a native send above the per-send limit", () => {
    const r = resolveSend({ action: "send_mon", to: ALICE, amountMon: "0.9" }, { policy: rules });
    assert.equal(r.ok, false);
    assert.match(r.reason, /^policy maxPerSend:/);
  });

  test("no policy leaves every write action untouched", () => {
    assert.equal(resolveSend({ action: "send_token", to: BOB, token: "USDC", amount: "5" }).ok, true);
    assert.equal(resolveSend({ action: "send_mon", to: BOB, amountMon: "99" }).ok, true);
  });

  test("an invalid amount is refused, not thrown, even without a policy", () => {
    const r = resolveSend({ action: "send_mon", to: BOB, amountMon: "nope" });
    assert.equal(r.ok, false);
    assert.match(r.reason, /invalid amount/);
  });

  test("swap is not a send: resolveSend does not apply the allowlist or require `to`", () => {
    const r = resolveSend(
      { action: "swap", amountIn: "1", tokenIn: "MON", tokenOut: "USDC" },
      { policy: rules },
    );
    assert.equal(r.ok, true);
    assert.equal(r.recipient, null);
  });
});

describe("checkSwapPolicy", () => {
  const amountRules = loadPolicy(policyFile({ maxPerSend: "0.5", maxPerSession: "1" }));
  const allowOnly = loadPolicy(policyFile({ allowlist: [ALICE] }));
  const both = loadPolicy(policyFile({ maxPerSend: "0.5", allowlist: [ALICE] }));

  test("no policy allows every swap", () => {
    assert.equal(checkSwapPolicy(null, { nativeIn: true, value: parseMon("100") }).ok, true);
    assert.equal(checkSwapPolicy(null, { nativeIn: false, value: null }).ok, true);
  });

  test("enforces maxPerSend on a native MON swap", () => {
    const ok = checkSwapPolicy(amountRules, { nativeIn: true, value: parseMon("0.4") });
    const bad = checkSwapPolicy(amountRules, { nativeIn: true, value: parseMon("0.6") });
    assert.equal(ok.ok, true);
    assert.equal(bad.ok, false);
    assert.equal(bad.rule, "maxPerSend");
  });

  test("enforces maxPerSession on a native MON swap", () => {
    const v = checkSwapPolicy(amountRules, {
      nativeIn: true,
      value: parseMon("0.4"),
      sessionSpent: parseMon("0.8"),
    });
    assert.equal(v.ok, false);
    assert.equal(v.rule, "maxPerSession");
  });

  test("refuses an ERC-20-input swap when MON amount limits are configured", () => {
    const v = checkSwapPolicy(amountRules, { nativeIn: false, value: null });
    assert.equal(v.ok, false);
    assert.equal(v.rule, "maxPerSend");
    assert.match(v.message, /cannot be evaluated/);
  });

  test("allowlist-only policy does not block a swap (no third-party recipient)", () => {
    assert.equal(checkSwapPolicy(allowOnly, { nativeIn: true, value: parseMon("9") }).ok, true);
    assert.equal(checkSwapPolicy(allowOnly, { nativeIn: false, value: null }).ok, true);
  });

  test("allowlist plus MON limits still enforces the amount on a native swap", () => {
    const v = checkSwapPolicy(both, { nativeIn: true, value: parseMon("0.9") });
    assert.equal(v.ok, false);
    assert.equal(v.rule, "maxPerSend");
  });
});

describe("describeSwapPolicy", () => {
  test("is silent without amount rules", () => {
    assert.equal(describeSwapPolicy(null, { nativeIn: true, value: parseMon("1") }), null);
    const allowOnly = loadPolicy(policyFile({ allowlist: [ALICE] }));
    assert.equal(describeSwapPolicy(allowOnly, { nativeIn: true, value: parseMon("1") }), null);
  });

  test("reports the session budget on a native swap", () => {
    const p = loadPolicy(policyFile({ maxPerSession: "10" }));
    assert.equal(
      describeSwapPolicy(p, { nativeIn: true, value: parseMon("2.5"), sessionSpent: 0n }),
      "2.5 of 10.0 MON session budget",
    );
  });
});
