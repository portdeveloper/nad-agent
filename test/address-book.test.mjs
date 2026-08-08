/**
 * Unit tests for address-book name resolution (Issue #2).
 *
 * resolveInBook is pure (input + an in-memory book), so most cases need no file.
 * resolveRecipient adds the on-disk load; one temp-file test covers that path.
 * Uses node:test + node:assert. Zero new dependencies.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress } from "ethers";
import { resolveInBook, resolveRecipient, describeAction, runAction } from "../src/tools.mjs";
import { config } from "../src/config.mjs";

const A = getAddress("0x000000000000000000000000000000000000dead");
const B = getAddress("0x8ba1f109551bd432803012645ac136ddd64dba72");

describe("resolveInBook — raw addresses", () => {
  it("checksums an all-lowercase address", () => {
    assert.deepEqual(resolveInBook(A.toLowerCase()), { ok: true, address: A, name: null });
  });

  it("passes a correctly-checksummed address through", () => {
    assert.deepEqual(resolveInBook(B), { ok: true, address: B, name: null });
  });

  it("refuses a mixed-case address that fails the EIP-55 checksum", () => {
    // "dEaD" is the canonical casing; "DeaD" is mixed-case and wrong.
    const r = resolveInBook("0x000000000000000000000000000000000000DeaD");
    assert.equal(r.ok, false);
    assert.match(r.reason, /checksum/i);
  });
});

describe("resolveInBook — names", () => {
  const book = { alice: A, Bob: B, bad: "0xnope", Alice: A };

  it("resolves a known name", () => {
    assert.deepEqual(resolveInBook("alice", book), { ok: true, address: A, name: "alice" });
  });

  it("matches case-insensitively", () => {
    const r = resolveInBook("BOB", book);
    assert.equal(r.ok, true);
    assert.equal(r.address, B);
  });

  it("refuses an unknown name", () => {
    const r = resolveInBook("carol", book);
    assert.equal(r.ok, false);
    assert.match(r.reason, /not a known name/i);
  });

  it("refuses a name whose entry is not a valid address", () => {
    const r = resolveInBook("bad", book);
    assert.equal(r.ok, false);
    assert.match(r.reason, /not a valid address/i);
  });

  it("refuses an ambiguous name (same name, two different addresses)", () => {
    const r = resolveInBook("alice", { alice: A, Alice: B });
    assert.equal(r.ok, false);
    assert.match(r.reason, /ambiguous/i);
  });

  it("accepts a case-variant that maps to the same address", () => {
    assert.deepEqual(resolveInBook("alice", { alice: A, Alice: A }), { ok: true, address: A, name: "alice" });
  });

  it("refuses empty input", () => {
    assert.equal(resolveInBook("").ok, false);
  });
});

describe("resolveRecipient — on-disk book", () => {
  it("loads the book at config.addressBookPath and resolves a name", () => {
    const path = join(tmpdir(), `nad-agent-book-${process.pid}.json`);
    writeFileSync(path, JSON.stringify({ alice: A }));
    const prev = config.addressBookPath;
    config.addressBookPath = path;
    try {
      assert.deepEqual(resolveRecipient("alice"), { ok: true, address: A, name: "alice" });
      assert.equal(resolveRecipient("carol").ok, false);
    } finally {
      config.addressBookPath = prev;
      rmSync(path, { force: true });
    }
  });

  it("resolves a raw address even when the book file is missing", () => {
    const prev = config.addressBookPath;
    config.addressBookPath = join(tmpdir(), "nad-agent-does-not-exist-xyz.json");
    try {
      assert.deepEqual(resolveRecipient(A.toLowerCase()), { ok: true, address: A, name: null });
    } finally {
      config.addressBookPath = prev;
    }
  });
});

describe("describeAction / runAction with a resolved recipient", () => {
  it("preview shows the name next to the resolved address", () => {
    const out = describeAction({ action: "send_mon", amountMon: "0.1" }, { ok: true, address: A, name: "alice" });
    assert.ok(out.includes("alice"), out);
    assert.ok(out.includes(A), out);
  });

  it("runAction refuses when the resolved recipient failed", async () => {
    const res = await runAction({ action: "send_mon", amountMon: "1" }, { ok: false, reason: "nope" });
    assert.match(String(res), /refused/i);
  });
});
