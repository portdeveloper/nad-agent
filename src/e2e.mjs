/**
 * Non-interactive smoke test (`npm run smoke`). Exercises the real product logic
 * — WDK wallet on Monad + QVAC local model + tools — without the readline REPL,
 * so it runs cleanly in CI / piped shells. Uses dry-run so it needs no Pimlico key.
 */

import { config, describeConfig } from "./config.mjs";
import * as wallet from "./wallet.mjs";
import * as brain from "./agent.mjs";
import { systemPrompt, parseAction, runAction } from "./tools.mjs";

const TEST_ADDR = "0x000000000000000000000000000000000000dEaD";
const log = (s = "") => console.log(s);
const indent = (s) => "  " + String(s).replace(/\n/g, "\n  ");

log("── nad-agent smoke test ──");
log(describeConfig());
log();

// 1) Wallet: init + reads (real, against Monad RPC)
const addr = await wallet.initWallet();
log("wallet initialized: " + addr + ` (account #${wallet.getAccountIndex()})`);
log("get_address -> " + (await runAction({ action: "get_address" })));
log("get_balance -> " + (await runAction({ action: "get_balance" })));

// 1b) Multi-account: derive siblings from the same seed, switch, switch back.
// Address derivation is counterfactual (no RPC), so this must always work.
log("\naccounts (same seed, BIP-44 m/44'/60'/0'/0/N):");
const accounts = await wallet.listAccounts(3);
for (const a of accounts) log(`  #${a.index} ${a.address}${a.active ? "  <- active" : ""}`);
if (new Set(accounts.map((a) => a.address)).size !== accounts.length) {
  throw new Error("account addresses are not distinct");
}
const sibling = config.accountIndex + 1;
const addrSibling = await wallet.switchAccount(sibling);
if (addrSibling === addr) throw new Error("switching accounts did not change the address");
if (wallet.getAddress() !== addrSibling) throw new Error("getAddress() does not track the active account");
log(`switch -> #${sibling} ${addrSibling}`);
log(`get_balance (account #${sibling}) -> ` + (await runAction({ action: "get_balance" })));
const addrBack = await wallet.switchAccount(config.accountIndex);
if (addrBack !== addr) throw new Error("switching back did not restore the original address");
log(`switch back -> #${wallet.getAccountIndex()} ${addrBack}`);

// 2) Dry-run send via the tools layer (no Pimlico key -> simulated)
log("\nsend_mon (dry-run):");
log(indent(await runAction({ action: "send_mon", to: TEST_ADDR, amountMon: "0.01" })));

// 3) Local model: natural language -> action -> execute
log("\nloading local model…");
const t0 = process.hrtime.bigint();
await brain.loadBrain();
log(`model ready (${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1)}s)`);

for (const q of ["what is my MON balance?", `send 0.05 MON to ${TEST_ADDR}`]) {
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
