import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAction, isWrite, ACTIONS, systemPrompt, runAction } from "../src/tools.mjs";

// JSON path
test("parseAction: JSON get_address", () => {
  assert.equal(parseAction('{"action":"get_address"}').action, "get_address");
});

test("parseAction: JSON get_balance", () => {
  assert.equal(parseAction('{"action":"get_balance"}').action, "get_balance");
});

test("parseAction: JSON send_mon with args", () => {
  const r = parseAction('{"action":"send_mon","to":"0xabcdef1234567890abcdef1234567890abcdef12","amountMon":"1.5"}');
  assert.equal(r.action, "send_mon");
  assert.equal(r.to, "0xabcdef1234567890abcdef1234567890abcdef12");
  assert.equal(r.amountMon, "1.5");
});

test("parseAction: JSON none action", () => {
  assert.equal(parseAction('{"action":"none"}').action, "none");
});

// send_mon missing amountMon — action still parsed, caller validates args
test("parseAction: send_mon missing amountMon still returns action", () => {
  const r = parseAction('{"action":"send_mon","to":"0xabcdef1234567890abcdef1234567890abcdef12"}');
  assert.equal(r.action, "send_mon");
});

// JSON embedded in surrounding text. cli.mjs feeds the raw model output to
// parseAction, so this is the real shape Qwen3 produces: a <think> block of
// prose, then the one-line JSON action.
test("parseAction: JSON after a Qwen3 think block", () => {
  const raw =
    "<think>The user wants their balance. I should call get_balance.</think>\n" +
    '{"action":"get_balance"}';
  assert.equal(parseAction(raw).action, "get_balance");
});

test("parseAction: JSON inside prose and a code fence", () => {
  const raw = 'Sure! Here you go:\n```json\n{"action":"get_address"}\n```\nDone.';
  assert.equal(parseAction(raw).action, "get_address");
});

test("parseAction: multiline JSON with whitespace", () => {
  const r = parseAction(
    '{\n  "action": "send_mon",\n  "to": "0xabcdef1234567890abcdef1234567890abcdef12",\n  "amountMon": "0.5"\n}'
  );
  assert.equal(r.action, "send_mon");
  assert.equal(r.amountMon, "0.5");
});

// Lenient fallback path (small-model plain-text output)
test("parseAction: lenient get_balance() text", () => {
  assert.equal(parseAction("get_balance()").action, "get_balance");
});

test("parseAction: lenient get_address() text", () => {
  assert.equal(parseAction("get_address()").action, "get_address");
});

// send_mon must NOT be triggered by the lenient path (write action requires JSON)
test("parseAction: lenient path does not trigger send_mon", () => {
  assert.equal(
    parseAction("send_mon(0xabcdef1234567890abcdef1234567890abcdef12, 1.0)").action,
    "none"
  );
});

// Malformed JSON falls through to lenient path
test("parseAction: malformed JSON with get_balance falls to lenient", () => {
  assert.equal(parseAction("{bad json} get_balance").action, "get_balance");
});

// Junk / unrelated input
test("parseAction: junk input returns none", () => {
  assert.equal(parseAction("what is the weather today?").action, "none");
});

test("parseAction: empty string returns none", () => {
  assert.equal(parseAction("").action, "none");
});

test("parseAction: unknown action in JSON returns none", () => {
  assert.equal(parseAction('{"action":"transfer_tokens"}').action, "none");
});

// isWrite
test("isWrite: send_mon is a write", () => {
  assert.equal(isWrite("send_mon"), true);
});

test("isWrite: get_balance is not a write", () => {
  assert.equal(isWrite("get_balance"), false);
});

test("isWrite: get_address is not a write", () => {
  assert.equal(isWrite("get_address"), false);
});

// ACTIONS export shape
test("ACTIONS has expected keys", () => {
  for (const name of ["get_address", "get_balance", "send_mon", "none"]) {
    assert.ok(name in ACTIONS, `missing action: ${name}`);
  }
});

// systemPrompt stays in sync with the ACTIONS table: every action the
// interpreter accepts must be described to the model.
test("systemPrompt lists every action", () => {
  const prompt = systemPrompt();
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(prompt.includes(name), `systemPrompt missing action: ${name}`);
  }
});

// runAction refuses a send to a bad address BEFORE touching the wallet.
// This guard is what stops a hallucinated address from ever reaching WDK.
test("runAction: send_mon to invalid address is refused without a wallet", async () => {
  const out = await runAction({ action: "send_mon", to: "not-an-address", amountMon: "1" });
  assert.match(out, /^Refused:/);
});

test("runAction: none action returns null (caller falls back to chat)", async () => {
  assert.equal(await runAction({ action: "none" }), null);
});
