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
import { parseAction, describeAction, runAction, isWrite, ACTIONS } from "../src/tools.mjs";
import { config } from "../src/config.mjs";
import { buildNftTransferCalldata, ERC721_ABI } from "../src/wallet.mjs";
import { Interface, getAddress } from "ethers";

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

describe("runAction — get_nfts / transfer_nft guards", () => {
  it("get_nfts with invalid address returns refusal", async () => {
    const res = await runAction({ action: "get_nfts", address: "not-an-address" });
    assert.match(String(res), /refused/i);
  });

  it("transfer_nft with invalid to returns refusal", async () => {
    const res = await runAction({ action: "transfer_nft", contractAddress: "0xabc", tokenId: "1", to: "not-an-address" });
    assert.match(String(res), /refused/i);
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

  it("refuses an address that is not one", () => {
    assert.throws(() => buildNftTransferCalldata("not-an-address", to, "1"));
  });
});
