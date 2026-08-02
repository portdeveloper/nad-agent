/**
 * Resolver tests. Uses the built-in node:test runner, so this adds no dependency.
 *
 * The cases that matter here are the refusals: this code chooses where money goes,
 * and every path that could quietly send to the wrong address is worth pinning down.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveRecipient, formatRecipient, loadAddressBook, safeEcho } from "../src/addressBook.mjs";

const A1 = "0x1111111111111111111111111111111111111111";
const A2 = "0x2222222222222222222222222222222222222222";

/** Point NAD_ADDRESS_BOOK at a temp file with the given contents (string or object). */
const MADE = [];
const ENV0 = process.env.NAD_ADDRESS_BOOK;
after(() => {
  for (const d of MADE) rmSync(d, { recursive: true, force: true });
  if (ENV0 === undefined) delete process.env.NAD_ADDRESS_BOOK;
  else process.env.NAD_ADDRESS_BOOK = ENV0;
});

function withBook(contents) {
  const dir = mkdtempSync(join(tmpdir(), "nad-book-"));
  MADE.push(dir);
  const path = join(dir, "address-book.json");
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  process.env.NAD_ADDRESS_BOOK = path;
  return path;
}


test("an alias resolves, case-insensitively", () => {
  withBook({ Alice: A1 });
  for (const spelling of ["Alice", "alice", "ALICE"]) {
    const r = resolveRecipient(spelling);
    assert.equal(r.ok, true, `${spelling} should resolve`);
    assert.equal(r.address, A1);
    assert.equal(r.name, "Alice", "the book's own spelling is what gets shown");
  }
});

test("an alias cannot shadow a raw address", () => {
  // The real shadowing attempt: the book uses the ADDRESS ITSELF as the alias name and
  // points it somewhere else. Previously this test used an unrelated key, so it passed
  // for any implementation that does not invent entries — i.e. it proved nothing.
  // The address-shaped key is dropped at load by VALID_NAME, so asserting on resolution
  // alone proved nothing. Assert BOTH halves: the key never enters the book, and a raw
  // address resolves to itself.
  withBook({ [A1]: A2, alice: A2 });
  const { entries, rejected } = loadAddressBook();
  assert.ok(!entries.has(A1.toLowerCase()), "an address-shaped key must not become an alias");
  assert.ok(rejected.has(A1.toLowerCase()), "and it must be reported as rejected, not ignored");
  const r = resolveRecipient(A1);
  assert.equal(r.ok, true);
  assert.equal(r.address, A1, "a raw address must never be looked up in the book");
});

test("an unknown name is refused, not guessed", () => {
  withBook({ alice: A1 });
  const r = resolveRecipient("bob");
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown recipient "bob"/);
  assert.match(r.reason, /Known aliases: alice/);
});

test("a near-miss address is refused as an address, not searched as a name", () => {
  withBook({ alice: A1 });
  const r = resolveRecipient("0x1111");
  assert.equal(r.ok, false);
  assert.match(r.reason, /looks like an address but is not a valid one/);
});

test("an entry with a bad address is dropped and the rest still work", () => {
  withBook({ alice: A1, broken: "0xnothex", also_broken: 12345 });
  const { warnings } = loadAddressBook();
  assert.equal(warnings.length, 2);
  assert.equal(resolveRecipient("alice").ok, true);
  assert.equal(resolveRecipient("broken").ok, false);
});

test("a name defined twice with different addresses refuses both", () => {
  // Parse order must never decide a recipient.
  withBook({ alice: A1, Alice: A2 });
  const r = resolveRecipient("alice");
  assert.equal(r.ok, false);
  assert.match(r.reason, /defined twice with different addresses/);
});


test("the confirm string cannot render two different addresses identically", () => {
  // 0x1111…1111 hides 32 of 40 hex chars: an attacker who picks the address needs no
  // vanity grinding at all for two entries to look the same to the operator.
  const B = "0x1111beefbeefbeefbeefbeefbeefbeefbeef1111";
  const a = formatRecipient({ address: A1, name: "alice" });
  const b = formatRecipient({ address: B, name: "alice" });
  // notEqual alone would pass for a truncating formatter whose truncations differ. What
  // matters is that each address appears in full, so the operator can compare it.
  assert.ok(a.includes(A1) && b.includes(B), "each address must be shown in full");
  assert.ok(!a.includes("…") && !b.includes("…"), "no elision in the string that authorises a transfer");
});

test("a rejected alias says it was rejected, not that it is unknown", () => {
  withBook({ alice: A1, treasury: "0x2222 2222" });
  const r = resolveRecipient("treasury");
  assert.equal(r.ok, false);
  assert.match(r.reason, /present in .* but was ignored/);
  assert.doesNotMatch(r.reason, /unknown recipient/);
});

test("an edited book takes effect without restarting", () => {
  const path = withBook({ alice: A1 });
  assert.equal(resolveRecipient("alice").address, A1);
  writeFileSync(path, JSON.stringify({ alice: A2 }));
  assert.equal(resolveRecipient("alice").address, A2, "a stale cache keeps paying a compromised address");
});

test("untrusted input is echoed printable and bounded", () => {
  withBook({ alice: A1 });
  const evil = resolveRecipient("0xNOPE\u001b[2K\r fake line");
  assert.doesNotMatch(evil.reason, /\u001b/, "no terminal control sequences reach the prompt");
  const long = resolveRecipient("b".repeat(100000));
  assert.ok(long.reason.length < 300, `reason was ${long.reason.length} chars`);
});

test("a lookup must obey the same rules as storage", () => {
  // U+212A KELVIN SIGN lowercases to "k", and trim() eats a BOM — so without this,
  // strings that could never be stored as an alias could still match one.
  withBook({ kelvin: A1, alice: A1 });
  assert.equal(resolveRecipient("Kelvin").ok, true, "ASCII still matches case-insensitively");
  assert.equal(resolveRecipient("\u212Aelvin").ok, false, "Kelvin sign must not fold into k");
  // A leading BOM is stripped by trim() and the result is a legitimate ASCII alias, which
  // is fine: the operator is shown the book's own spelling, so nothing is disguised.
  assert.equal(resolveRecipient("\uFEFFalice").ok, true);
});

test("an address-shaped alias name is rejected at load", () => {
  withBook({ [A1]: A2 });
  const { entries } = loadAddressBook();
  assert.equal(entries.size, 0, "the two namespaces must not overlap");
});

test("the same name twice with the same address is fine", () => {
  withBook({ alice: A1, Alice: A1 });
  const r = resolveRecipient("alice");
  assert.equal(r.ok, true);
  assert.equal(r.address, A1);
});

test("an absent default book is silent — the warning is gated on NAD_ADDRESS_BOOK", () => {
  // The invariant is not "no warnings" — a developer who follows the README keeps an
  // address-book.json in the repo root, and it may legitimately warn about its own contents.
  // What must hold is that an absent file is only reported when the operator named the path.
  delete process.env.NAD_ADDRESS_BOOK;
  const { warnings } = loadAddressBook();
  assert.ok(
    !warnings.some((w) => /does not exist/.test(w)),
    "an absent default book must not be reported as a missing path",
  );
  assert.equal(resolveRecipient(A1).ok, true, "raw addresses keep working with no book");
});

test("a path the operator typed that does not exist is reported, not silently empty", () => {
  // The other half of "unreadable is not empty", and the half that actually happens: a stale
  // NAD_ADDRESS_BOOK, a dangling symlink, or a relative path resolved from another cwd. All
  // three surface as ENOENT, and staying quiet turns them into "No aliases are defined" —
  // the operator hunts a typo in a book that was never opened.
  const gone = mkdtempSync(join(tmpdir(), "nad-gone-"));
  MADE.push(gone);
  process.env.NAD_ADDRESS_BOOK = join(gone, "absent.json");
  const { warnings } = loadAddressBook();
  assert.equal(warnings.length, 1, "an explicit path that is missing must be reported");
  assert.match(warnings[0], /does not exist/);
  // And the refusal at send time says the same thing. Reporting it only at startup left the
  // operator reading "No aliases are defined" at the moment it mattered — a scroll-back away
  // from the one line that explained it.
  const r = resolveRecipient("alice");
  assert.match(r.reason, /does not exist/);
  assert.doesNotMatch(r.reason, /No aliases are defined/);
  // Raw addresses still work: this is a warning, not a failure.
  assert.equal(resolveRecipient(A1).ok, true);
});

test("a corrupt book warns and refuses names instead of throwing", () => {
  withBook("{ not json");
  const { warnings } = loadAddressBook();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /not valid JSON/);
  assert.equal(resolveRecipient(A1).ok, true, "raw addresses must survive a broken book");
  const r = resolveRecipient("alice");
  assert.equal(r.ok, false);
  // "could not read" and "not in the book" are different statements, and only one of
  // them is true here. Saying the alias is unknown would send the operator looking for
  // a typo that isn't there.
  assert.match(r.reason, /could not be read/);
  assert.doesNotMatch(r.reason, /unknown recipient/);
});



test("a JSON array is rejected — the book must be an object", () => {
  withBook([{ alice: A1 }]);
  const { warnings } = loadAddressBook();
  assert.match(warnings[0], /must be a JSON object/);
});

test("empty and non-string recipients are refused", () => {
  withBook({ alice: A1 });
  for (const bad of ["", "   ", null, undefined, 42, [], {}, 0, false]) {
    assert.equal(resolveRecipient(bad).ok, false, `${JSON.stringify(bad)} must be refused`);
  }
  // Control: the same function still accepts what it should, so this is not passing
  // merely because everything is refused.
  assert.equal(resolveRecipient("alice").ok, true);
  assert.equal(resolveRecipient(A1).ok, true);
});

test("formatRecipient shows the address behind an alias", () => {
  assert.equal(formatRecipient({ address: A1, name: null }), A1);
  assert.equal(formatRecipient({ address: A1, name: "alice" }), `${A1}  (alias: alice)`);
});





test("a book that cannot be read is never reported as an empty book", () => {
  // Collapsing any open error into ENOENT made an unreadable book answer "unknown recipient
  // … No aliases are defined", sending the operator after a typo that is not there. A
  // directory is the one cause that is unreadable on every platform and every uid — mode 000
  // is not, because root ignores it, and a test that quietly skips proves nothing.
  const dir = mkdtempSync(join(tmpdir(), "nad-dir-"));
  MADE.push(dir);
  process.env.NAD_ADDRESS_BOOK = dir;
  const { unreadable, warnings } = loadAddressBook();
  assert.ok(unreadable, "a directory must be reported as unreadable");
  assert.match(warnings[0], /could not be read/);
  const r = resolveRecipient("alice");
  assert.match(r.reason, /could not be read/);
  assert.doesNotMatch(r.reason, /No aliases are defined/);
  assert.equal(resolveRecipient(A1).ok, true, "raw addresses still work without a book");
});


test("safeEcho cannot throw on a value whose toString is not callable", () => {
  // {"toString":1} is valid JSON, and describeAction runs outside any try in cli.mjs.
  const hostile = JSON.parse('{"toString":1}');
  assert.equal(typeof safeEcho(hostile), "string");
});

test("a raw address is handed to the send exactly as typed, character for character", () => {
  // The address is verified but never rewritten. If anything re-cased it on the way through,
  // the operator would approve one string and sign another.
  const typed = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";
  const r = resolveRecipient(typed);
  assert.equal(r.ok, true);
  assert.equal(r.address, typed);
  assert.equal(r.name, null, "a raw address has no alias attached");
  assert.equal(formatRecipient(r), typed, "no alias, so the line is the address alone");
});

test("a mixed-case address whose checksum does not match is refused, not sent", () => {
  // One flipped character invalidates the EIP-55 checksum, and that is the whole point of
  // having one. main refused these before this branch existed; losing that on the way through
  // a rebase would have let a mistyped address reach wallet.send with nothing to catch it.
  const good = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";
  const flipped = "0x8Ba1f109551bD432803012645Ac136ddd64DBA72";

  assert.equal(resolveRecipient(good).ok, true);
  const bad = resolveRecipient(flipped);
  assert.equal(bad.ok, false, "a broken checksum must not resolve");
  assert.match(bad.reason, /checksum/i);

  // An all-lowercase address carries no checksum at all, so it stays acceptable — refusing it
  // would reject the form most tools print.
  const lower = resolveRecipient(good.toLowerCase());
  assert.equal(lower.ok, true);
  assert.equal(lower.address, good.toLowerCase(), "still handed on exactly as typed");
});

test("a book entry with a broken checksum is rejected at load, with a reason", () => {
  // An alias is typed by hand too. Without this, the book would be the one remaining way a
  // mistyped address still reaches a send.
  withBook({ good: "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
             typo: "0x8Ba1f109551bD432803012645Ac136ddd64DBA72" });
  assert.equal(resolveRecipient("good").ok, true);
  const bad = resolveRecipient("typo");
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /checksum/i, "and it says why, rather than reading as unknown");
});
