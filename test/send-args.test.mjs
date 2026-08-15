import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveSend } from "../src/tools.mjs";

const DEAD = "0x000000000000000000000000000000000000dEaD";

// Amount validation lives in resolveSend, the single pre-prompt gate every
// write action passes through, so one suite here covers the /send slash path
// and the NL path alike (#51).
describe("send amount validation", () => {
  const refuse = (amountMon) => {
    const r = resolveSend({ action: "send_mon", to: DEAD, amountMon });
    assert.equal(r.ok, false, `expected "${amountMon}" to be refused`);
    assert.match(r.reason, /invalid amount/);
    return r.reason;
  };

  test("a non-numeric amount is refused in one line, not thrown", () => {
    refuse("abc");
    refuse("");
    refuse(undefined);
    refuse("1,5");
  });

  test("a negative amount is refused before it reaches the wallet", () => {
    const reason = refuse("-1");
    assert.match(reason, /greater than zero/);
  });

  test("a zero amount is refused before it reaches the wallet", () => {
    const reason = refuse("0");
    assert.match(reason, /greater than zero/);
    refuse("0.0");
  });

  test("an amount with more than 18 decimals is refused instead of throwing", () => {
    refuse("0.0000000000000000001"); // 19 decimals — parseEther would throw
  });

  test("scientific notation is refused rather than guessed at", () => {
    refuse("1e18");
  });

  test("a refused amount is echoed neutralised, never raw", () => {
    // The amount comes from model output; a refusal that echoes it verbatim
    // would hand ANSI escapes to the terminal (the simError lesson from #43).
    const reason = refuse("\x1b[2A0.5\x07");
    assert.doesNotMatch(reason, /[\x00-\x1f\x7f]/);
  });

  test("the smallest representable send, 1 wei, still passes", () => {
    const r = resolveSend({ action: "send_mon", to: DEAD, amountMon: "0.000000000000000001" });
    assert.equal(r.ok, true);
  });

  test("a normal amount still passes", () => {
    assert.equal(resolveSend({ action: "send_mon", to: DEAD, amountMon: "0.5" }).ok, true);
  });

  test("a token send is untouched by the MON amount rules", () => {
    // Token amounts are validated against token decimals in the token path;
    // the MON parser must not run on them at all.
    const r = resolveSend({ action: "send_token", to: DEAD, token: "USDC", amount: "abc" });
    assert.equal(r.ok, true);
  });
});
