import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getHistory, normalizeHistoryTransaction } from "../src/wallet.mjs";
import { config } from "../src/config.mjs";

const OWNER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const HASH = `0x${"a".repeat(64)}`;

describe("normalizeHistoryTransaction", () => {
  it("normalizes an incoming explorer transaction", () => {
    assert.deepEqual(
      normalizeHistoryTransaction({ hash: HASH, from: { hash: OTHER }, to: { hash: OWNER }, value: "42" }, OWNER),
      {
        hash: HASH,
        direction: "in",
        amount: 42n,
        timestamp: null,
        explorerUrl: `${config.chain.explorerUrl}/tx/${HASH}`,
      },
    );
  });

  it("normalizes an outgoing internal transaction", () => {
    const result = normalizeHistoryTransaction(
      { transaction_hash: HASH, from: OWNER, to: OTHER, value: "0x2a", timestamp: "2026-08-24T12:00:00Z" },
      OWNER,
    );
    assert.equal(result.direction, "out");
    assert.equal(result.amount, 42n);
    assert.equal(result.hash, HASH);
  });

  it("ignores transactions unrelated to the account", () => {
    assert.equal(normalizeHistoryTransaction({ hash: HASH, from: OTHER, to: OTHER, value: "1" }, OWNER), null);
  });

  it("ignores records without a transaction hash", () => {
    assert.equal(normalizeHistoryTransaction({ from: OWNER, to: OTHER, value: "1" }, OWNER), null);
  });
});

describe("getHistory", () => {
  it("combines explorer transactions and internal transactions newest first", async () => {
    const incomingHash = `0x${"b".repeat(64)}`;
    const outgoingHash = `0x${"c".repeat(64)}`;
    const requested = [];
    const fetchImpl = async (url) => {
      requested.push(url);
      const internal = url.endsWith("/internal-transactions");
      return {
        ok: true,
        async json() {
          return { items: internal
            ? [{ transaction_hash: outgoingHash, from: OWNER, to: OTHER, value: "20", timestamp: "2026-08-24T12:00:00Z" }]
            : [{ hash: incomingHash, from: { hash: OTHER }, to: { hash: OWNER }, value: "10", timestamp: "2026-08-24T13:00:00Z" }] };
        },
      };
    };

    const result = await getHistory({ ownerAddress: OWNER, fetchImpl });
    assert.deepEqual(result.map(({ hash, direction, amount }) => ({ hash, direction, amount })), [
      { hash: incomingHash, direction: "in", amount: 10n },
      { hash: outgoingHash, direction: "out", amount: 20n },
    ]);
    assert.equal(requested.length, 2);
  });

  it("uses the endpoint that succeeds when the other explorer endpoint fails", async () => {
    const fetchImpl = async (url) => {
      if (url.endsWith("/internal-transactions")) return { ok: false, status: 404, statusText: "Not Found" };
      return {
        ok: true,
        async json() {
          return { items: [{ hash: HASH, from: OTHER, to: OWNER, value: "1" }] };
        },
      };
    };
    const result = await getHistory({ ownerAddress: OWNER, fetchImpl });
    assert.equal(result.length, 1);
    assert.equal(result[0].hash, HASH);
  });

  it("applies the requested result limit", async () => {
    const items = [1, 2, 3].map((value) => ({
      hash: `0x${String(value).repeat(64)}`,
      from: OTHER,
      to: OWNER,
      value: String(value),
      timestamp: `2026-08-24T1${value}:00:00Z`,
    }));
    const fetchImpl = async (url) => ({
      ok: true,
      async json() { return { items: url.endsWith("/internal-transactions") ? [] : items }; },
    });
    const result = await getHistory({ ownerAddress: OWNER, limit: 2, fetchImpl });
    assert.equal(result.length, 2);
    assert.deepEqual(result.map((tx) => tx.amount), [3n, 2n]);
  });
});
