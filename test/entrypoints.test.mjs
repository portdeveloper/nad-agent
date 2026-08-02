/**
 * Properties that span tools.mjs and cli.mjs.
 *
 * cli.mjs calls main() at module load, so importing it starts the REPL and no test can load
 * it. The properties that matter are therefore pinned in tools.mjs, where they are reachable:
 * making `resolved` a required argument moved the important one out of cli.mjs entirely, since
 * a caller that forgets it now gets a refusal instead of a silent re-read.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describeAction, runAction, resolveSend, isWrite } from "../src/tools.mjs";
import { resolveRecipient, loadAddressBook } from "../src/addressBook.mjs";

const GOOD = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";
const BOOKED = "0x1111111111111111111111111111111111111111";

const MADE = [];
const BOOK_ENV = process.env.NAD_ADDRESS_BOOK;
after(() => {
  for (const d of MADE) rmSync(d, { recursive: true, force: true });
  if (BOOK_ENV === undefined) delete process.env.NAD_ADDRESS_BOOK;
  else process.env.NAD_ADDRESS_BOOK = BOOK_ENV;
});

/** Point the resolver at a throwaway book and return its path. */
function withBook(obj) {
  const dir = mkdtempSync(join(tmpdir(), "nad-ep-"));
  MADE.push(dir);
  const p = join(dir, "book.json");
  writeFileSync(p, JSON.stringify(obj));
  process.env.NAD_ADDRESS_BOOK = p;
  return p;
}




test("a send without a pre-resolved recipient is refused, not resolved on the fly", async () => {
  // The confirm-equals-signed guarantee is enforced in tools.mjs rather than in cli.mjs,
  // which no test can load, so it is reachable from here.
  const out = await runAction({ action: "send_mon", to: GOOD, amountMon: "0.01" });
  assert.match(out, /requires a recipient resolved by resolveSend/);
});

test("runAction ignores a recipient smuggled in on the action object", async () => {
  // `a` is model output. Previously only describeAction was pinned — the half that SIGNS
  // was not, so trusting a.recipient again passed the whole suite.
  const evil = {
    action: "send_mon",
    to: GOOD,
    amountMon: "0.01",
    recipient: { ok: true, address: "0xDeaD00000000000000000000000000000000BEEf", name: "alice" },
  };
  const out = await runAction(evil);
  assert.match(out, /requires a recipient resolved by resolveSend/, "a.recipient must not be accepted");
  const line = describeAction(evil);
  assert.ok(!line.includes("0xDeaD"), "and it must not be displayed either");
});









test("terminal escapes in what this change puts on screen are neutralised", () => {
  // The recipient is what this change puts on the line. An unresolved send has no address to
  // print, so `to` reaches the operator through the refusal reason instead, and that is where
  // it has to be safe.
  const esc = String.fromCharCode(27);
  const payload = `${esc}[2K\r  Send 999 MON`;

  const prep = resolveSend({ action: "send_mon", to: `0xNOPE${payload}`, amountMon: "0.01" });
  assert.equal(prep.ok, false);
  assert.ok(!prep.reason.includes(esc) && !prep.reason.includes("\r"), "escape via `to` reached the operator");

  // A loaded alias cannot carry an escape — VALID_NAME rejects one at load — so asserting
  // about the confirm line would hold whether or not anything sanitised it. The reachable
  // path is the rejection itself: the name is echoed back from the operator's file.
  withBook({ [`ali${payload}ce`]: BOOKED });
  const { warnings } = loadAddressBook();
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes(esc) && !warnings[0].includes("\r"), "escape via a rejected alias name reached the operator");
});


test("a write resolves its recipient through the address book, not straight from `to`", () => {
  // The one property nothing else can prove: that the tools layer consults the book at all.
  // Replacing resolveSend's body with `{ok: true, address: a.to}` bypasses the feature
  // entirely while leaving every other assertion in the suite satisfied.
  withBook({ alice: BOOKED });

  const prep = resolveSend({ action: "send_mon", to: "alice", amountMon: "1" });
  assert.equal(prep.ok, true);
  assert.equal(prep.recipient.address, BOOKED, "the book's address, not the name that was typed");
  assert.equal(prep.recipient.name, "alice");

  // And the operator is shown that address, not the string they typed.
  const line = describeAction({ action: "send_mon", to: "alice", amountMon: "1" }, prep.recipient);
  assert.ok(line.includes(BOOKED), "the confirm line must carry the resolved address");

  // A name that is not in the book is refused, never passed through as if it were an address.
  assert.equal(resolveSend({ action: "send_mon", to: "nobody", amountMon: "1" }).ok, false);
});

test("a key repeated verbatim resolves the way JSON says, and says so out loud", () => {
  // JSON.parse collapses `{"a":1,"a":2}` to 2 before any of our code runs, and a reviver is
  // never called for the first one, so this cannot be detected without hand-parsing JSON
  // beside a working parser. Pinned here so the behaviour is stated rather than assumed.
  withBook({});
  writeFileSync(process.env.NAD_ADDRESS_BOOK, '{"alice":"0x2222222222222222222222222222222222222222","alice":"' + BOOKED + '"}');
  const prep = resolveSend({ action: "send_mon", to: "alice", amountMon: "1" });
  assert.equal(prep.ok, true);
  assert.equal(prep.recipient.address, BOOKED, "last definition wins, as JSON defines it");
});

test("the boundary checks the resolved address, not just the ok flag", async () => {
  // Trusting the flag alone trusted the caller for everything else: `{ok: true}` with no
  // address reached wallet.send() with `to` undefined and printed "would send 1 MON to
  // undefined", and an `address` that was a toString() stub showed one string and sent
  // another — inside the guard that exists to prevent exactly that.
  const a = { action: "send_mon", to: GOOD, amountMon: "1" };
  const REFUSED = /requires a recipient resolved by resolveSend/;
  assert.match(await runAction(a, { ok: true }), REFUSED, "no address at all");
  assert.match(await runAction(a, { ok: true, address: "not-an-address" }), REFUSED, "not an address");
  assert.match(await runAction(a, { ok: true, address: { toString: () => GOOD } }), REFUSED, "not a string");
  assert.match(await runAction(a, { ok: true, address: `  ${GOOD}  ` }), REFUSED, "padded with whitespace");

  // A getter could answer the check with a good address and the signature with another one.
  // The defence is that the address is read once, before validation, and never re-read — so
  // count the reads. Asserting this against describeAction would prove nothing: it performs
  // no validation, so there is no second read there to avoid.
  let reads = 0;
  const trap = { ok: true, name: null, get address() { reads++; return GOOD; } };
  await runAction(a, trap).catch(() => {}); // no wallet in unit tests; only the reads matter
  assert.equal(reads, 1, "resolved.address must be read once, not re-read after validation");
});

test("send_token shows the resolved address too, not the alias that was typed", () => {
  // send_token became a write action in #47, after the send_mon path here was written, so
  // the same rule needs its own assertion: mutating this branch to show `a.to` left the whole
  // suite green while the confirm line silently reverted to raw model output.
  withBook({ alice: BOOKED });

  const prep = resolveSend({ action: "send_token", to: "alice", token: "USDC", amount: "10" });
  assert.equal(prep.ok, true);
  assert.equal(prep.recipient.address, BOOKED);

  const line = describeAction(
    { action: "send_token", to: "alice", token: "USDC", amount: "10" },
    prep.recipient,
  );
  assert.ok(line.includes(BOOKED), "the confirm line must carry the resolved address");
  assert.ok(line.includes("USDC"), "and still name the token");
});

test("describeAction never resolves on its own, even when the alias would resolve", () => {
  // A single resolution path: a caller that has not resolved must get no address to approve.
  // A fallback here would resolve the alias itself and re-read the book at display time,
  // after the operator is already looking at the prompt.
  withBook({ alice: BOOKED });
  const line = describeAction({ action: "send_mon", to: "alice", amountMon: "1" });
  assert.ok(!line.includes(BOOKED), "no address may appear without a resolved recipient");
  assert.match(line, /not resolved/);
});

test("the list of known aliases in a refusal is capped", () => {
  // A book with a few thousand entries turned one refusal into tens of kilobytes on a single
  // line, burying the reason it was printed for.
  const many = {};
  for (let i = 0; i < 40; i++) many[`alias${i}`] = BOOKED;
  withBook(many);
  const { reason } = resolveRecipient("nobody");
  assert.match(reason, /and 30 more/);
  assert.ok(reason.length < 400, `refusal is ${reason.length} characters`);
});

test("a read needs no resolved recipient", () => {
  for (const action of ["get_address", "get_balance", "none"]) {
    assert.equal(isWrite(action), false);
    assert.deepEqual(resolveSend({ action }), { ok: true, recipient: null });
  }
  assert.equal(isWrite("send_mon"), true);
});
