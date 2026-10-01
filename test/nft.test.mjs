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
import { parseAction, describeAction, runAction, isWrite, ACTIONS, systemPrompt, isRefusal } from "../src/tools.mjs";
import { buildNftTransferCalldata, ERC721_ABI, normalizeNftPage, transferNft } from "../src/wallet.mjs";
import { Interface, getAddress } from "ethers";
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

  it("get_nfts with bad address checksum returns refusal instead of throwing", async () => {
    const BAD = "0x534B2f3A21130D7A60830C2Df862319E593943A3";
    const res = await runAction({ action: "get_nfts", address: BAD });
    assert.equal(isRefusal(res), true);
    assert.match(String(res), /^Refused:/);
    assert.match(String(res), /checksum failed/);
    assert.match(String(res), new RegExp(BAD));
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

  it("transfer_nft refuses a padded fromAddress rather than trimming it", async () => {
    // isAddress() trims internally, so " 0x… " passes the format check. The recipient guard
    // above already refuses padding for exactly this reason — otherwise the padded value
    // reaches the confirmation line ragged, which is the line the operator approves.
    const resolved = { ok: true, address: "0x1234567890abcdef1234567890abcdef12345678", name: null };
    const padded = ` ${resolved.address} `;
    const res = await runAction(
      { action: "transfer_nft", contractAddress: resolved.address, tokenId: "1",
        to: resolved.address, fromAddress: padded },
      resolved,
    );
    assert.match(String(res), /refused/i);
    assert.match(String(res), /fromAddress/i);
    // The line the operator reads is rendered before runAction runs, so a late refusal does
    // not save it — feed the padded value to describeAction directly and require it clean.
    const line = describeAction(
      { action: "transfer_nft", contractAddress: resolved.address, tokenId: "1",
        to: resolved.address, fromAddress: padded },
      resolved,
    );
    assert.ok(!/\(from {2}/.test(line), `confirmation line has doubled spacing: ${line}`);
    assert.ok(!line.includes(`${padded})`), `padding survived into: ${line}`);
  });

  it("describeAction neutralises control characters in fromAddress", async () => {
    // This is the line the operator reads and approves, and runAction's refusal happens
    // only afterwards — so whatever describeAction renders is what a person acts on. An
    // unsanitised value carrying ESC[2K (erase line) or CR could rewrite what was already
    // printed, immediately above the confirm prompt. safeEcho keeps the line printable.
    const ESC = String.fromCharCode(27);
    const CR = String.fromCharCode(13);
    const resolved = { ok: true, address: "0x1234567890abcdef1234567890abcdef12345678", name: null };
    const hostile = `${resolved.address.slice(0, 20)}${ESC}[2K${CR}Send NFT to attacker`;
    const line = describeAction(
      { action: "transfer_nft", contractAddress: resolved.address, tokenId: "1",
        to: resolved.address, fromAddress: hostile },
      resolved,
    );
    assert.ok(!line.includes(ESC), "ESC survived into the confirmation line");
    assert.ok(!line.includes(CR), "CR survived into the confirmation line");
  });

  it("describeAction neutralises control characters in tokenId and contract", () => {
    // transfer_nft is the one write whose confirmation line comes from describeAction:
    // cli.mjs gives send_mon, send_token and swap their own preview blocks and falls through
    // to describeAction for everything else. tokenId and contractAddress are model output and
    // reach the line raw, so the same argument that put safeEcho on fromAddress applies here.
    const ESC = String.fromCharCode(27);
    const CR = String.fromCharCode(13);
    const resolved = { ok: true, address: "0x1234567890abcdef1234567890abcdef12345678", name: null };

    const byTokenId = describeAction(
      { action: "transfer_nft", contractAddress: resolved.address,
        tokenId: `1${ESC}[2K${CR}Send NFT to attacker`, to: resolved.address },
      resolved,
    );
    assert.ok(!byTokenId.includes(ESC), "ESC survived through tokenId");
    assert.ok(!byTokenId.includes(CR), "CR survived through tokenId");

    const byContract = describeAction(
      { action: "transfer_nft", contractAddress: `${resolved.address}${ESC}[2K${CR}x`,
        tokenId: "1", to: resolved.address },
      resolved,
    );
    assert.ok(!byContract.includes(ESC), "ESC survived through contractAddress");
    assert.ok(!byContract.includes(CR), "CR survived through contractAddress");
  });

  it("describeAction bounds tokenId and contract without pushing out the recipient", () => {
    // Length matters for the same reason control characters do: fields long enough to wrap
    // push the recipient off the visible line, and the operator approves what is left. The
    // bounds are the longest legitimate value of each field — 78 digits for a uint256 token
    // id, 42 characters for an address — so a real transfer is never truncated, and the
    // recipient stays whole no matter what the model sent.
    const resolved = { ok: true, address: "0x1234567890abcdef1234567890abcdef12345678", name: null };
    const line = describeAction(
      { action: "transfer_nft", contractAddress: "0x" + "a".repeat(400),
        tokenId: "9".repeat(400), to: resolved.address },
      resolved,
    );
    assert.ok(line.includes(resolved.address), `recipient was pushed out of: ${line}`);
    assert.ok(line.includes("..."), "oversized fields were not truncated");
    // 78 + 42 bounded fields, their ellipses, the 42-character recipient and the fixed text.
    assert.ok(line.length < 260, `confirmation line was not bounded: ${line.length} chars`);
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

describe("buildNftTransferCalldata — decoded calldata", () => {
  const iface = new Interface(ERC721_ABI);
  const from = "0x1234567890abcdef1234567890abcdef12345678";
  const to = "0xabcdef1234567890abcdef1234567890abcdef12";

  it("encodes safeTransferFrom with the three arguments", () => {
    const data = buildNftTransferCalldata(from, to, "730");
    const decoded = iface.decodeFunctionData("safeTransferFrom", data);
    assert.equal(decoded[0], getAddress(from));
    assert.equal(decoded[1], getAddress(to));
    assert.equal(decoded[2], 730n);
  });

  it("uses the safeTransferFrom selector", () => {
    const data = buildNftTransferCalldata(from, to, "1");
    assert.equal(data.slice(0, 10), iface.getFunction("safeTransferFrom").selector);
  });

  it("takes a tokenId too large for a Number", () => {
    const big = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
    const decoded = iface.decodeFunctionData(
      "safeTransferFrom",
      buildNftTransferCalldata(from, to, big),
    );
    assert.equal(decoded[2], BigInt(big));
  });

  /**
   * What a token id may be, and what each shape has to mean. Both directions in one table on
   * purpose: a shape that encodes and a shape that is refused are statements about the same
   * guard, and listing them apart is how one half drifts.
   *
   * `"0"` and `""` are the pair that matters. Token #0 is a real token, so a bare `BigInt`
   * turned an empty id into a complete, signable transfer of it. They have to part ways here.
   */
  const MAX_UINT256 = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
  const TOKEN_IDS = [
    ["a decimal string", "730", 730n],
    ["zero", "0", 0n],
    ["a hex string", "0x2a", 42n],
    ["a padded string", " 42 ", 42n],
    ["a number", 42, 42n],
    ["a bigint", 42n, 42n],
    ["the largest uint256", MAX_UINT256, BigInt(MAX_UINT256)],
    ["an empty string", "", null],
    ["a blank string", "   ", null],
    ["a word", "abc", null],
    ["a decimal fraction", "1.5", null],
    ["exponent notation", "1e3", null],
    ["a negative string", "-1", null],
    ["a negative number", -1, null],
    ["one past the largest uint256", (BigInt(MAX_UINT256) + 1n).toString(), null],
    ["null", null, null],
    ["undefined", undefined, null],
    ["true", true, null],
    ["false", false, null],
    ["an empty array", [], null],
    ["a single-element array", ["5"], null],
    ["an object", {}, null],
    ["an object with a toString", { toString: () => "7" }, null],
  ];

  for (const [name, tokenId, expected] of TOKEN_IDS) {
    it(`${expected === null ? "refuses" : "encodes"} ${name}`, () => {
      if (expected === null) {
        assert.throws(
          () => buildNftTransferCalldata(from, to, tokenId),
          // The message is the point, not just the throw: every other unusable field on this
          // path answers with a refusal the operator can read, and this one used to answer
          // with whatever BigInt or ethers said.
          (err) => err.message.startsWith("Refused:"),
          `tokenId=${String(tokenId)} must be refused, and as a refusal`,
        );
      } else {
        const decoded = iface.decodeFunctionData("safeTransferFrom", buildNftTransferCalldata(from, to, tokenId));
        assert.equal(decoded[2], expected);
      }
    });
  }

  it("refuses the same ids from the ownership check, not only from the encoder", async () => {
    // The two used to convert separately and agree on a fabricated id: BigInt("") asked
    // ownerOf about token #0 while the calldata encoded token #0, so the check confirmed a
    // token nobody named. This is reachable without a wallet only because the id is resolved
    // before the session check — everything after it needs an initialised account.
    for (const tokenId of ["", "   ", "abc", "-1", null, {}]) {
      await assert.rejects(
        transferNft(to, from, tokenId),
        (err) => err.message.startsWith("Refused:"),
        `tokenId=${String(tokenId)} must be refused before the wallet is consulted`,
      );
    }
  });

  it("refuses an address that is not one", () => {
    assert.throws(() => buildNftTransferCalldata("not-an-address", to, "1"));
  });
});
