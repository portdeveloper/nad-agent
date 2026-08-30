/**
 * Unit tests for ERC-721 NFT reads and transfers (Issue #20).
 *
 * Tests src/tools.mjs parseAction/describeAction/isWrite/runAction for get_nfts
 * and transfer_nft. Uses node:test + node:assert. Zero new dependencies.
 *
 * The happy paths hit live Monad RPC / Reservoir, so they're exercised on testnet
 * (see the test plan in the PR) — the unit layer covers the action surface only.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAction, describeAction, runAction, isWrite, ACTIONS, systemPrompt } from "../src/tools.mjs";
import { normalizeNftPage } from "../src/wallet.mjs";
import { config } from "../src/config.mjs";

// ---------------------------------------------------------------------------
// ACTIONS shape
// ---------------------------------------------------------------------------

describe("ACTIONS — get_nfts / transfer_nft", () => {
  it("get_nfts is in ACTIONS", () => {
    assert.ok("get_nfts" in ACTIONS, "get_nfts should be an action");
  });

  it("get_nfts has correct args", () => {
    assert.deepEqual(ACTIONS.get_nfts.args, ["address"]);
  });

  it("transfer_nft is in ACTIONS", () => {
    assert.ok("transfer_nft" in ACTIONS, "transfer_nft should be an action");
  });

  it("transfer_nft has correct args", () => {
    assert.deepEqual(ACTIONS.transfer_nft.args, ["to", "contractAddress", "tokenId"]);
  });
});

// ---------------------------------------------------------------------------
// parseAction — get_nfts (JSON + lenient read-only fallback)
// ---------------------------------------------------------------------------

describe("parseAction — get_nfts", () => {
  it("parses get_nfts JSON", () => {
    assert.deepEqual(parseAction('{"action":"get_nfts"}'), { action: "get_nfts" });
  });

  it("parses get_nfts JSON with an address", () => {
    assert.deepEqual(
      parseAction('{"action":"get_nfts","address":"0x1234567890abcdef1234567890abcdef12345678"}'),
      { action: "get_nfts", address: "0x1234567890abcdef1234567890abcdef12345678" },
    );
  });

  it("plain-text get_nfts() is recognized (read-only)", () => {
    assert.deepEqual(parseAction("get_nfts()"), { action: "get_nfts" });
  });

  it("ownership phrases map to get_nfts", () => {
    assert.deepEqual(parseAction("what NFTs do I own?"), { action: "get_nfts" });
    assert.deepEqual(parseAction("show my nfts"), { action: "get_nfts" });
    assert.deepEqual(parseAction("nfts in my wallet"), { action: "get_nfts" });
  });

  it("'send my NFT to ...' does NOT become a read", () => {
    assert.deepEqual(parseAction("send my NFT to 0x1234567890abcdef1234567890abcdef12345678"), {
      action: "none",
    });
  });
});

// ---------------------------------------------------------------------------
// parseAction — transfer_nft
// ---------------------------------------------------------------------------

describe("parseAction — transfer_nft", () => {
  it("parses transfer_nft JSON", () => {
    assert.deepEqual(
      parseAction(
        '{"action":"transfer_nft","to":"0x1234567890abcdef1234567890abcdef12345678","contractAddress":"0x1234567890abcdef1234567890abcdef12345678","tokenId":"7"}',
      ),
      {
        action: "transfer_nft",
        to: "0x1234567890abcdef1234567890abcdef12345678",
        contractAddress: "0x1234567890abcdef1234567890abcdef12345678",
        tokenId: "7",
      },
    );
  });

  it("accepts toAddress as the recipient alias", () => {
    assert.deepEqual(
      parseAction(
        '{"action":"transfer_nft","toAddress":"0x1234567890abcdef1234567890abcdef12345678","contractAddress":"0x1234567890abcdef1234567890abcdef12345678","tokenId":"3"}',
      ).toAddress,
      "0x1234567890abcdef1234567890abcdef12345678",
    );
  });

  it("lenient fallback does NOT auto-trigger transfer_nft", () => {
    assert.deepEqual(parseAction("transfer_nft(0x1234567890abcdef1234567890abcdef12345678, 0x1234567890abcdef1234567890abcdef12345678, 1)"), {
      action: "none",
    });
  });
});

// ---------------------------------------------------------------------------
// isWrite
// ---------------------------------------------------------------------------

describe("isWrite — get_nfts / transfer_nft", () => {
  it("transfer_nft is a write", () => {
    assert.equal(isWrite("transfer_nft"), true);
  });

  it("get_nfts is not a write", () => {
    assert.equal(isWrite("get_nfts"), false);
  });
});

// ---------------------------------------------------------------------------
// describeAction
// ---------------------------------------------------------------------------

describe("describeAction — get_nfts / transfer_nft", () => {
  it("get_nfts returns a read label", () => {
    assert.equal(describeAction({ action: "get_nfts" }), "Read: your ERC-721 NFTs");
  });

  it("transfer_nft names the contract, tokenId and resolved recipient", () => {
    const out = describeAction(
      { action: "transfer_nft", contractAddress: "0x1234567890abcdef1234567890abcdef12345678", tokenId: "7", to: "0xabc" },
      { ok: true, address: "0x1234567890abcdef1234567890abcdef12345678" },
    );
    assert.ok(out.includes("#7"), `expected tokenId in \"${out}\"`);
    assert.ok(out.includes("0x1234567890abcdef1234567890abcdef12345678"), `expected contract in \"${out}\"`);
  });

  it("dry-run label matches gasMode", () => {
    const expected =
      config.gasMode === "dry-run" ? "DRY RUN" :
      config.gasMode === "sponsored" ? "gasless" :
      "you pay gas";
    const out = describeAction(
      { action: "transfer_nft", contractAddress: "0xabc", tokenId: "1", to: "0xabc" },
      { ok: true, address: "0xabc" },
    );
    assert.ok(out.includes(expected), `expected \"${expected}\" in \"${out}\"`);
  });

  it("unknown action → No on-chain action", () => {
    assert.equal(describeAction({ action: "bogus" }), "No on-chain action");
  });
});

// ---------------------------------------------------------------------------
// runAction — guards
// ---------------------------------------------------------------------------

describe("transfer_nft — model-facing signature", () => {
  it("systemPrompt offers fromAddress, marked optional", () => {
    // desc has always told the model it may pass fromAddress, but systemPrompt() builds the
    // signature from args, so the parameter never appeared in the list the model reads.
    // It cannot go in args itself: hasRequiredArgs() treats every entry there as mandatory,
    // which would break every transfer that legitimately omits it.
    const line = systemPrompt().split("\n").find((l) => l.includes("transfer_nft("));
    assert.ok(line, "systemPrompt should list transfer_nft");
    assert.ok(line.includes("fromAddress?"), `fromAddress missing or unmarked in: ${line}`);
  });

  it("omitting fromAddress still parses as a complete action", () => {
    const parsed = parseAction(
      '{"action":"transfer_nft","to":"0x1234567890abcdef1234567890abcdef12345678",' +
      '"contractAddress":"0x1234567890abcdef1234567890abcdef12345678","tokenId":"7"}',
    );
    assert.equal(parsed.action, "transfer_nft");
  });
});

describe("runAction — get_nfts / transfer_nft guards", () => {
  it("get_nfts with invalid address returns refusal", async () => {
    const res = await runAction({ action: "get_nfts", address: "not-an-address" });
    assert.match(String(res), /refused/i);
  });

  it("transfer_nft with invalid to returns refusal", async () => {
    const res = await runAction({ action: "transfer_nft", contractAddress: "0xabc", tokenId: "1", to: "not-an-address" });
    assert.match(String(res), /refused/i);
  });

  it("transfer_nft refuses a malformed fromAddress instead of throwing", async () => {
    // fromAddress was the one field on this path that reached ethers unchecked: a garbage
    // value came back as a raw `invalid address (argument="address"…)` throw from inside the
    // wallet rather than the Refused: line every other rejection here produces. The refusal
    // has to happen before the wallet is touched, which is also why this needs no wallet.
    const resolved = { ok: true, address: "0x1234567890abcdef1234567890abcdef12345678", name: null };
    const res = await runAction(
      { action: "transfer_nft", contractAddress: "0x1234567890abcdef1234567890abcdef12345678",
        tokenId: "1", to: resolved.address, fromAddress: "not-an-address" },
      resolved,
    );
    assert.match(String(res), /refused/i);
    assert.match(String(res), /fromAddress/i);
  });

  it("transfer_nft refuses an empty fromAddress rather than silently sending from self", async () => {
    // "" is falsy only at the call site — the default parameter never kicks in, so it still
    // reaches checksumAddress. Refusing beats quietly transferring from the agent's own
    // wallet when the caller clearly meant to name a different owner.
    const resolved = { ok: true, address: "0x1234567890abcdef1234567890abcdef12345678", name: null };
    const res = await runAction(
      { action: "transfer_nft", contractAddress: "0x1234567890abcdef1234567890abcdef12345678",
        tokenId: "1", to: resolved.address, fromAddress: "" },
      resolved,
    );
    assert.match(String(res), /refused/i);
    // isAddress() alone would already refuse this, but as `Refused: "" is not a valid
    // fromAddress` — a pair of quotes and no explanation. The separate branch exists for the
    // message, so assert the message, not just that something was refused.
    assert.match(String(res), /empty/i);
    assert.match(String(res), /omit it/i);
  });

  it("transfer_nft with missing contract returns refusal", async () => {
    const resolved = { ok: true, address: "0x1234567890abcdef1234567890abcdef12345678", name: null };
    const res = await runAction({ action: "transfer_nft", tokenId: "1", to: "0x1234567890abcdef1234567890abcdef12345678" }, resolved);
    assert.match(String(res), /contract/i);
  });

  it("transfer_nft with missing tokenId returns refusal", async () => {
    const resolved = { ok: true, address: "0x1234567890abcdef1234567890abcdef12345678", name: null };
    const res = await runAction(
      { action: "transfer_nft", contractAddress: "0x1234567890abcdef1234567890abcdef12345678", to: "0x1234567890abcdef1234567890abcdef12345678" },
      resolved,
    );
    assert.match(String(res), /tokenId/i);
  });
});

// ---------------------------------------------------------------------------
// normalizeNftPage — the Reservoir page mapping (issue #68)
// ---------------------------------------------------------------------------

const CONTRACT_A = "0x1111111111111111111111111111111111111111";
const CONTRACT_B = "0x2222222222222222222222222222222222222222";
const good = (tokenId, name) => ({ token: { contract: CONTRACT_A, tokenId, ...(name ? { name } : {}) } });

describe("normalizeNftPage — one bad row must not discard the response", () => {
  it("keeps the usable tokens and counts the ones it dropped", () => {
    // Before this, checksumAddress(undefined) threw out of the .map() and the caller got an
    // error line instead of the tokens it did own.
    const page = {
      tokens: [
        good("7", "First"),
        { token: { tokenId: "9" } },                 // no contract at all
        { token: { contract: "not-an-address", tokenId: "11" } },
        good("13"),
        { token: null },                             // container present, nothing in it
        null,                                        // row itself missing
      ],
    };
    const { tokens, skipped } = normalizeNftPage(page);
    assert.deepEqual(tokens.map((t) => t.tokenId), ["7", "13"]);
    assert.equal(skipped, 4);
    assert.equal(tokens[0].name, "First");
    assert.equal(tokens[1].name, undefined);
  });

  it("never emits the string \"undefined\" as a tokenId", () => {
    // String(t.tokenId) used to render "undefined" in the list and could be handed straight
    // to transfer_nft as a tokenId.
    const { tokens, skipped } = normalizeNftPage({
      tokens: [{ token: { contract: CONTRACT_B } }, { token: { contract: CONTRACT_B, tokenId: "" } }],
    });
    assert.deepEqual(tokens, []);
    assert.equal(skipped, 2);
  });

  it("accepts a numeric tokenId and returns it as a string", () => {
    const { tokens } = normalizeNftPage({ tokens: [{ token: { contract: CONTRACT_A, tokenId: 42 } }] });
    assert.deepEqual(tokens, [{ contract: CONTRACT_A, tokenId: "42" }]);
  });

  it("keeps tokenId 0, which is valid and falsy", () => {
    // The reason the guard tests for undefined/null/empty rather than falsiness: token id 0
    // is a real id, and a truthiness check would silently drop it.
    const { tokens, skipped } = normalizeNftPage({ tokens: [{ token: { contract: CONTRACT_A, tokenId: 0 } }] });
    assert.deepEqual(tokens, [{ contract: CONTRACT_A, tokenId: "0" }]);
    assert.equal(skipped, 0);
  });

  it("drops a malformed name instead of rendering [object Object]", () => {
    // Same shape as the tokenId problem, one step quieter: String({}) reaches the operator's
    // list as "[object Object]". The name is decoration, so the token survives without it.
    const { tokens } = normalizeNftPage({
      tokens: [{ token: { contract: CONTRACT_A, tokenId: "1", name: { evil: true } } }],
    });
    assert.deepEqual(tokens, [{ contract: CONTRACT_A, tokenId: "1" }]);
  });

  it("checksums the contract rather than passing the indexer's casing through", () => {
    const { tokens } = normalizeNftPage({ tokens: [{ token: { contract: CONTRACT_A.toLowerCase(), tokenId: "1" } }] });
    assert.equal(tokens[0].contract, CONTRACT_A);
  });
});

describe("normalizeNftPage — truncation is reported, not silent", () => {
  it("flags a page that has a continuation cursor", () => {
    const { tokens, truncated } = normalizeNftPage({ tokens: [good("1")], continuation: "cursor-abc" });
    assert.equal(tokens.length, 1);
    assert.equal(truncated, true);
  });

  it("does not flag a complete page", () => {
    assert.equal(normalizeNftPage({ tokens: [good("1")] }).truncated, false);
    assert.equal(normalizeNftPage({ tokens: [good("1")], continuation: null }).truncated, false);
  });

  it("survives a response that is missing or malformed entirely", () => {
    for (const page of [undefined, null, {}, { tokens: null }, { tokens: "nope" }]) {
      assert.deepEqual(normalizeNftPage(page), { tokens: [], skipped: 0, truncated: false });
    }
  });
});
