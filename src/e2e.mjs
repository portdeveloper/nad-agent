/**
 * Non-interactive smoke test (`npm run smoke`). Exercises the real product logic
 * — WDK wallet on Monad + QVAC local model + tools — without the readline REPL,
 * so it runs cleanly in CI / piped shells. Uses dry-run so it needs no Pimlico key.
 */

import { config, describeConfig } from "./config.mjs";
import * as wallet from "./wallet.mjs";
import * as brain from "./agent.mjs";
import { systemPrompt, parseAction, runAction, buildSwapPreview } from "./tools.mjs";

const TEST_ADDR = "0x000000000000000000000000000000000000dEaD";
const log = (s = "") => console.log(s);
const indent = (s) => "  " + String(s).replace(/\n/g, "\n  ");

log("── nad-agent smoke test ──");
log(describeConfig());
log();

// 1) Wallet: init + reads (real, against Monad RPC)
const addr = await wallet.initWallet();
log("wallet initialized: " + addr);
log("get_address -> " + (await runAction({ action: "get_address" })));
log("get_balance -> " + (await runAction({ action: "get_balance" })));

// 2) Dry-run send via the tools layer (no Pimlico key -> simulated)
log("\nsend_mon (dry-run):");
log(indent(await runAction({ action: "send_mon", to: TEST_ADDR, amountMon: "0.01" })));

// 3) Swap: real router quote (eth_call) then a dry-run swap. The quote is live
//    even with no key and no funds, so this checks the DEX wiring for real.
if (config.chain.dex) {
  log(`\nswap quote + dry-run (${config.chain.dex.name}):`);
  const swap = { action: "swap", amountIn: "5", tokenIn: "USDC", tokenOut: "WMON" };
  const preview = await buildSwapPreview(swap);
  if (preview.error) {
    log(indent(`quote unavailable: ${preview.error}`));
  } else {
    log(indent(preview.block));
    log(indent(await runAction(swap, { preview })));
  }
}

// 4) Local model: natural language -> action -> execute
log("\nloading local model…");
const t0 = process.hrtime.bigint();
await brain.loadBrain();
log(`model ready (${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1)}s)`);

for (const q of ["what is my MON balance?", `send 0.05 MON to ${TEST_ADDR}`, "swap 5 USDC for WMON"]) {
  log(`\nNL › "${q}"`);
  const history = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: q },
  ];
  const raw = await brain.complete(history);
  log("  model raw:    " + JSON.stringify(raw.slice(0, 160)));
  const action = parseAction(raw);
  log("  parsed:       " + JSON.stringify(action));
  const out = await runAction(action);
  if (out != null) log("  result:       " + indent(out).trim());
}

await brain.unloadBrain();
wallet.dispose();
log("\nSMOKE_OK");
