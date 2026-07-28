/**
 * Non-interactive smoke test (`npm run smoke`). Exercises the real product logic
 * — WDK wallet on Monad + QVAC local model + tools — without the readline REPL,
 * so it runs cleanly in CI / piped shells. Uses dry-run so it needs no Pimlico key.
 */

import { config, describeConfig } from "./config.mjs";
import * as wallet from "./wallet.mjs";
import * as brain from "./agent.mjs";
import { NATIVE_TOOLS, systemPrompt, resolveAction, runAction } from "./tools.mjs";

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

// 3) Local model: natural language -> action -> execute
log("\nloading local model…");
const t0 = process.hrtime.bigint();
await brain.loadBrain();
log(`model ready (${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1)}s)`);
const nativeTools = brain.usesNativeTools();
log(`tool-calling: ${nativeTools ? "native (completion({ tools }))" : "legacy (v0 JSON protocol)"}`);

for (const q of ["what is my MON balance?", `send 0.05 MON to ${TEST_ADDR}`]) {
  log(`\nNL › "${q}"`);
  const history = [
    { role: "system", content: systemPrompt(nativeTools) },
    { role: "user", content: q },
  ];
  const res = await brain.complete(history, undefined, nativeTools ? NATIVE_TOOLS : undefined);
  log("  model raw:    " + JSON.stringify(res.text.slice(0, 160)));
  const action = resolveAction(res);
  log("  via:          " + (res.native ? `native (${res.toolCalls.length} toolCall)` : "legacy parse"));
  log("  parsed:       " + JSON.stringify(action));
  const out = await runAction(action);
  if (out != null) log("  result:       " + indent(out).trim());
}

await brain.unloadBrain();
wallet.dispose();
log("\nSMOKE_OK");
