/**
 * get_nfts must keep a page whose indexer rows carry unusable token ids, and say so (Issue #110).
 *
 * The normalisation is covered row by row in nft.test.mjs. This file covers what the operator
 * actually reads: the `get_nfts` output, produced from an indexer response that arrives as text,
 * so the id is rounded or poisoned by the real JSON.parse inside the real fetch path rather than
 * by a fixture that hands over objects.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

const CONTRACT = "0x3333333333333333333333333333333333333333";
const OWNER = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";

// Written by hand: JSON.stringify could not produce 9007199254740993 or a `toString` key that
// survives as data, and both have to reach the agent exactly as an indexer could send them.
const PAGE =
  `{"tokens":[` +
  `{"token":{"contract":"${CONTRACT}","tokenId":9007199254740993}},` +
  `{"token":{"contract":"${CONTRACT}","tokenId":{"toString":null}}},` +
  `{"token":{"contract":"${CONTRACT}","tokenId":"7","name":"Neighbour"}}` +
  `]}`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(PAGE);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
after(() => {
  server.closeAllConnections();
  server.close();
});

// config.mjs reads the environment once at import time, so the indexer has to be pointed at the
// fixture BEFORE tools.mjs (and through it wallet.mjs) loads. Each test file runs in its own
// process, so this touches nothing else.
process.env.RESERVOIR_API_URL = `http://127.0.0.1:${server.address().port}`;
process.env.RESERVOIR_API_KEY ||= "test-key";
const { runAction } = await import("../src/tools.mjs");

describe("get_nfts output — unusable token ids", () => {
  it("lists the valid neighbour, never the rounded id, and reports both skipped rows", async () => {
    const out = await runAction({ action: "get_nfts", address: OWNER });
    assert.match(out, /Neighbour \(tokenId 7\)/);
    assert.doesNotMatch(out, /9007199254740992/, "the rounded id must not be listed as if it were owned");
    assert.doesNotMatch(out, /9007199254740993/, "the original digits are gone after the parse; nothing may claim them");
    assert.match(out, /\(2 entries from the indexer could not be read and were skipped\)/);
  });
});
