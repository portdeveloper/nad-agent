/**
 * Unit tests for the swap action (Issue #14) — parsing, routing helpers,
 * wrap refusal, slippage math. Live router quotes belong in `npm run smoke`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIONS,
  parseAction,
  parseSwapPhrase,
  mergeFreshQuote,
  isWrite,
  needsRecipient,
  describeAction,
  systemPrompt,
} from "../src/tools.mjs";
import { config } from "../src/config.mjs";
import {
  applySlippage,
  buildCandidatePaths,
  buildSwapCalls,
  isWrapPair,
  ROUTER_ABI,
  SWAP_DEADLINE_SECONDS,
} from "../src/swap.mjs";
import { Interface, getAddress } from "ethers";

const USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3";
const WMON = "0x97B3070F9Da6C002343862b35E68Bd8e22608943";
const USDT = "0x1314b22df27BDcD4F8D11a0f4185943e55748917";

describe("ACTIONS — swap", () => {
  it("swap is in ACTIONS", () => {
    assert.ok("swap" in ACTIONS);
  });
  it("swap args are amountIn, tokenIn, tokenOut", () => {
    assert.deepEqual(ACTIONS.swap.args, ["amountIn", "tokenIn", "tokenOut"]);
  });
  it("systemPrompt mentions swap", () => {
    assert.ok(systemPrompt().includes("swap"));
  });
});

describe("parseAction — swap JSON", () => {
  it("parses a full swap object", () => {
    assert.deepEqual(
      parseAction('{"action":"swap","amountIn":"5","tokenIn":"USDC","tokenOut":"WMON"}'),
      { action: "swap", amountIn: "5", tokenIn: "USDC", tokenOut: "WMON" },
    );
  });
  it("accepts from/to/amount aliases", () => {
    assert.deepEqual(
      parseAction('{"action":"swap","amount":"0.1","from":"MON","to":"USDC"}'),
      { action: "swap", amountIn: "0.1", tokenIn: "MON", tokenOut: "USDC" },
    );
  });
});

describe("parseSwapPhrase", () => {
  it("swap 5 USDC for WMON", () => {
    assert.deepEqual(parseSwapPhrase("swap 5 USDC for WMON"), {
      action: "swap",
      amountIn: "5",
      tokenIn: "USDC",
      tokenOut: "WMON",
    });
  });
  it("swap 0.1 MON to USDC", () => {
    assert.deepEqual(parseAction("please swap 0.1 MON to USDC"), {
      action: "swap",
      amountIn: "0.1",
      tokenIn: "MON",
      tokenOut: "USDC",
    });
  });
  it("does not parse a phrase without an amount", () => {
    assert.equal(parseSwapPhrase("swap USDC for WMON"), null);
  });
  it("still does not guess a send from free text", () => {
    assert.deepEqual(parseAction("send 1 MON to 0x000000000000000000000000000000000000dEaD"), {
      action: "none",
    });
  });
});

describe("isWrite / needsRecipient — swap", () => {
  it("swap is a write", () => {
    assert.equal(isWrite("swap"), true);
  });
  it("swap does not need a third-party recipient", () => {
    assert.equal(needsRecipient("swap"), false);
  });
  it("send_mon still needs a recipient", () => {
    assert.equal(needsRecipient("send_mon"), true);
  });
});

describe("describeAction — swap", () => {
  it("names both tokens", () => {
    const out = describeAction({ action: "swap", amountIn: "5", tokenIn: "USDC", tokenOut: "WMON" });
    assert.ok(out.includes("USDC"), out);
    assert.ok(out.includes("WMON"), out);
    assert.ok(out.includes("5"), out);
  });
  it("gas label matches config.gasMode", () => {
    const expected =
      config.gasMode === "dry-run" ? "DRY RUN" :
      config.gasMode === "sponsored" ? "gasless" :
      "you pay gas";
    const out = describeAction({ action: "swap", amountIn: "1", tokenIn: "MON", tokenOut: "USDC" });
    assert.ok(out.includes(expected), `expected "${expected}" in "${out}"`);
  });
});

describe("applySlippage", () => {
  it("0.5% of 10000 is 9950 (integer bps math)", () => {
    assert.equal(applySlippage(10_000n, 0.5), 9950n);
  });
  it("1% of 10000 is 9900", () => {
    assert.equal(applySlippage(10_000n, 1), 9900n);
  });
});

describe("buildCandidatePaths — star routing", () => {
  it("always includes the direct pair first", () => {
    const paths = buildCandidatePaths(USDC, WMON, [USDC, USDT, WMON]);
    assert.equal(paths[0][0].toLowerCase(), USDC.toLowerCase());
    assert.equal(paths[0][1].toLowerCase(), WMON.toLowerCase());
  });
  it("includes a one-hop via the remaining core", () => {
    const paths = buildCandidatePaths(USDC, WMON, [USDC, USDT, WMON]);
    const viaUsdt = paths.some(
      (p) => p.length === 3 && p[1].toLowerCase() === USDT.toLowerCase(),
    );
    assert.equal(viaUsdt, true);
  });
  it("does not emit adjacent duplicate hops", () => {
    const paths = buildCandidatePaths(USDC, WMON, [USDC, USDT, WMON]);
    for (const p of paths) {
      for (let i = 1; i < p.length; i++) {
        assert.notEqual(p[i], p[i - 1]);
      }
    }
  });
});

describe("isWrapPair", () => {
  const dex = config.chain.dex;
  it("MON -> PuddleSwap WMON is a wrap", () => {
    const mon = { symbol: "MON", address: WMON, native: true };
    const wmon = { symbol: "WMON", address: WMON, native: false };
    assert.equal(isWrapPair(mon, wmon, dex), true);
  });
  it("USDC -> WMON is not a wrap", () => {
    const usdc = { symbol: "USDC", address: USDC, native: false };
    const wmon = { symbol: "WMON", address: WMON, native: false };
    assert.equal(isWrapPair(usdc, wmon, dex), false);
  });
});

describe("mergeFreshQuote — confirm-click re-quote", () => {
  const shown = { path: [WMON, USDC], amountOut: 1000n, minOut: 990n, label: "WMON -> USDC", hops: 1, index: 0 };

  it("keeps the snapshot if the re-quote failed", () => {
    const r = mergeFreshQuote(shown, null, 1);
    assert.equal(r.ok, true);
    assert.equal(r.quote, shown);
  });

  it("raises the min-out floor when the fresh quote is better", () => {
    const fresh = { path: [WMON, USDC], amountOut: 2000n, hops: 1, label: "WMON -> USDC" };
    const r = mergeFreshQuote(shown, fresh, 1);
    assert.equal(r.ok, true);
    assert.equal(r.quote.amountOut, 2000n);
    assert.equal(r.quote.minOut, applySlippage(2000n, 1));
  });

  it("keeps the shown min-out if the fresh quote is only slightly worse but still above it", () => {
    const fresh = { path: [WMON, USDT, USDC], amountOut: 995n, hops: 2, label: "WMON -> USDT -> USDC" };
    const r = mergeFreshQuote(shown, fresh, 1);
    assert.equal(r.ok, true);
    assert.equal(r.quote.minOut, 990n);
    assert.equal(r.quote.label, "WMON -> USDT -> USDC");
  });

  it("refuses when output falls below the min-out that was shown", () => {
    const fresh = { path: [WMON, USDC], amountOut: 980n, hops: 1, label: "WMON -> USDC" };
    const r = mergeFreshQuote(shown, fresh, 1);
    assert.equal(r.ok, false);
    assert.match(r.error, /min-out/);
  });
});

describe("buildSwapCalls — decoded calldata", () => {
  const router = getAddress(config.chain.dex.router);
  const recipient = getAddress("0x1111111111111111111111111111111111111111");
  const routerIface = new Interface(ROUTER_ABI);
  const erc20Iface = new Interface(["function approve(address spender, uint256 amount) returns (bool)"]);
  const amountIn = 10n ** 17n; // 0.1
  const minOut = 2_000_000n;

  function deadlineWindow(decodedDeadline) {
    const now = Math.floor(Date.now() / 1000);
    const d = Number(decodedDeadline);
    assert.ok(d >= now + SWAP_DEADLINE_SECONDS - 5, `deadline ${d} too early vs ${now}`);
    assert.ok(d <= now + SWAP_DEADLINE_SECONDS + 5, `deadline ${d} too late vs ${now}`);
  }

  it("native in: swapExactETHForTokens, value = amountIn, no approve", () => {
    const path = [WMON, USDC].map(getAddress);
    const calls = buildSwapCalls({
      path,
      amountInRaw: amountIn,
      minAmountOutRaw: minOut,
      recipient,
      nativeIn: true,
      nativeOut: false,
      needsApproval: false,
    });
    assert.equal(calls.length, 1);
    assert.equal(getAddress(calls[0].to), router);
    assert.equal(calls[0].value, amountIn);
    const parsed = routerIface.parseTransaction({ data: calls[0].data });
    assert.equal(parsed.name, "swapExactETHForTokens");
    assert.equal(parsed.args[0], minOut);
    assert.deepEqual(parsed.args[1].map(getAddress), path);
    assert.equal(getAddress(parsed.args[2]), recipient);
    deadlineWindow(parsed.args[3]);
  });

  it("native out: swapExactTokensForETH, value 0, optional approve first", () => {
    const path = [USDC, WMON].map(getAddress);
    const calls = buildSwapCalls({
      path,
      amountInRaw: amountIn,
      minAmountOutRaw: minOut,
      recipient,
      nativeIn: false,
      nativeOut: true,
      needsApproval: true,
    });
    assert.equal(calls.length, 2);
    assert.equal(getAddress(calls[0].to), getAddress(USDC));
    assert.equal(calls[0].value, 0n);
    const approve = erc20Iface.parseTransaction({ data: calls[0].data });
    assert.equal(approve.name, "approve");
    assert.equal(getAddress(approve.args[0]), router);
    assert.equal(approve.args[1], amountIn);

    assert.equal(getAddress(calls[1].to), router);
    assert.equal(calls[1].value, 0n);
    const parsed = routerIface.parseTransaction({ data: calls[1].data });
    assert.equal(parsed.name, "swapExactTokensForETH");
    assert.equal(parsed.args[0], amountIn);
    assert.equal(parsed.args[1], minOut);
    assert.deepEqual(parsed.args[2].map(getAddress), path);
    assert.equal(getAddress(parsed.args[3]), recipient);
    deadlineWindow(parsed.args[4]);
  });

  it("token to token: swapExactTokensForTokens plus exact approve", () => {
    const path = [USDC, USDT].map(getAddress);
    const calls = buildSwapCalls({
      path,
      amountInRaw: amountIn,
      minAmountOutRaw: minOut,
      recipient,
      nativeIn: false,
      nativeOut: false,
      needsApproval: true,
    });
    assert.equal(calls.length, 2);
    const approve = erc20Iface.parseTransaction({ data: calls[0].data });
    assert.equal(approve.name, "approve");
    assert.equal(getAddress(approve.args[0]), router);
    assert.equal(approve.args[1], amountIn);

    const parsed = routerIface.parseTransaction({ data: calls[1].data });
    assert.equal(parsed.name, "swapExactTokensForTokens");
    assert.equal(getAddress(calls[1].to), router);
    assert.equal(calls[1].value, 0n);
    assert.equal(parsed.args[0], amountIn);
    assert.equal(parsed.args[1], minOut);
    assert.deepEqual(parsed.args[2].map(getAddress), path);
    assert.equal(getAddress(parsed.args[3]), recipient);
    deadlineWindow(parsed.args[4]);
  });

  it("skips approve when needsApproval is false", () => {
    const path = [USDC, USDT].map(getAddress);
    const calls = buildSwapCalls({
      path,
      amountInRaw: amountIn,
      minAmountOutRaw: minOut,
      recipient,
      nativeIn: false,
      nativeOut: false,
      needsApproval: false,
    });
    assert.equal(calls.length, 1);
    assert.equal(routerIface.parseTransaction({ data: calls[0].data }).name, "swapExactTokensForTokens");
  });
});
