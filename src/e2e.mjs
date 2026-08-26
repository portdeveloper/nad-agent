/**
 * Non-interactive smoke test (`npm run smoke`). Exercises the real product logic
 * — WDK wallet on Monad + QVAC local model + tools — without the readline REPL,
 * so it runs cleanly in CI / piped shells. Uses dry-run so it needs no Pimlico key.
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { config, describeConfig } from "./config.mjs";
import * as wallet from "./wallet.mjs";
import * as brain from "./agent.mjs";
import {
  systemPrompt,
  parseAction,
  runAction,
  resolveSend,
  prepareTokenSend,
  previewTokenSend,
  renderTokenSendPreview,
  buildSwapPreview,
  lockBestSwap,
} from "./tools.mjs";
import { flushSmokeSuccess } from "./smoke-exit.mjs";

// `npm run smoke` is a safety-critical dry-run check even when the operator's .env contains
// a Pimlico key. Force the shared config before wallet/tool code can execute a write, so this
// entrypoint can never turn its smoke sends into sponsored or native broadcasts.
config.gasMode = "dry-run";

// Avoid a highly repetitive address here: the bundled small model can occasionally
// drop one zero while copying it, which makes the model-driven smoke step flaky.
const TEST_ADDR = "0x1234567890abcdef1234567890abcdef12345678";
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
// A send resolves its recipient before it runs, exactly as the REPL does: the address the
// operator approves has to be the one that gets signed, so runAction refuses an unresolved one.
const send = { action: "send_mon", to: TEST_ADDR, amountMon: "0.01" };
const prep = resolveSend(send);
if (!prep.ok) throw new Error("send was refused before it ran: " + prep.reason);
const sent = await runAction(send, prep.recipient);
// A smoke test that prints SMOKE_OK after a refused send is worse than no smoke test.
if (sent.startsWith("Refused:")) throw new Error(sent);
log(indent(sent));

// 2b) The same path through an address-book alias, which is the only way to tell a send that
// consults the book from one that just signs whatever `to` it was handed: with a raw address
// the two are indistinguishable, because the resolved address is the string that came in.
const bookDir = mkdtempSync(join(tmpdir(), "nad-smoke-"));
const bookPath = join(bookDir, "address-book.json");
writeFileSync(bookPath, JSON.stringify({ "smoke-alias": TEST_ADDR }));
const prevBook = process.env.NAD_ADDRESS_BOOK;
process.env.NAD_ADDRESS_BOOK = bookPath;
try {
  log("\nsend_mon to an alias (dry-run):");
  const viaAlias = { action: "send_mon", to: "smoke-alias", amountMon: "0.02" };
  const aliasPrep = resolveSend(viaAlias);
  if (!aliasPrep.ok) throw new Error("alias did not resolve: " + aliasPrep.reason);
  if (aliasPrep.recipient.address !== TEST_ADDR) {
    throw new Error(`alias resolved to ${aliasPrep.recipient.address}, expected ${TEST_ADDR}`);
  }
  const aliasOut = await runAction(viaAlias, aliasPrep.recipient);
  if (aliasOut.startsWith("Refused:")) throw new Error(aliasOut);
  if (!aliasOut.includes(TEST_ADDR)) throw new Error("the receipt does not name the resolved address");
  if (!aliasOut.includes("0.02")) throw new Error("the receipt does not name the amount that was sent");
  log(indent(aliasOut));
} finally {
  if (prevBook === undefined) delete process.env.NAD_ADDRESS_BOOK;
  else process.env.NAD_ADDRESS_BOOK = prevBook;
  rmSync(bookDir, { recursive: true, force: true });
}

// 2c) Token send: prepare metadata and amount once, render the same confirmation data,
// then execute the exact prepared values in dry-run mode.
log("\nsend_token (dry-run):");
const tokenSend = { action: "send_token", token: "USDC", to: TEST_ADDR, amount: "0.01" };
const tokenPrep = await prepareTokenSend(tokenSend);
if (!tokenPrep.ok) throw new Error("token send was refused before preview: " + tokenPrep.reason);
const tokenPreview = await previewTokenSend(tokenPrep);
if (!tokenPreview.ok) throw new Error("token preview failed: " + tokenPreview.reason);
const tokenBlock = renderTokenSendPreview(tokenPreview);
if (!tokenBlock.includes("USDC") || !tokenBlock.includes(TEST_ADDR)) {
  throw new Error("token confirmation block is missing the token or resolved recipient");
}
log(indent(tokenBlock));
const tokenSent = await runAction(tokenSend, tokenPrep.recipient, { preparedToken: tokenPrep });
if (tokenSent.startsWith("Refused:")) throw new Error(tokenSent);
if (!tokenSent.includes("0.01") || !tokenSent.includes(TEST_ADDR)) {
  throw new Error("token dry-run receipt is missing the amount or resolved recipient");
}
log(indent(tokenSent));

// 2c) Swap quote + dry-run against the live PuddleSwap router (no key, no funds).
log("\nswap quote + dry-run (PuddleSwap):");
{
  const swap = { action: "swap", amountIn: "0.1", tokenIn: "MON", tokenOut: "USDC" };
  const preview = await buildSwapPreview(swap);
  if (preview.error) throw new Error("swap preview failed: " + preview.error);
  if (!preview.routes?.length) throw new Error("swap preview returned no routes");
  log(indent(preview.block));
  const locked = await lockBestSwap(preview);
  if (locked.error) throw new Error(locked.error);
  const swapped = await runAction(swap, null, { preview: locked });
  if (typeof swapped === "string" && swapped.startsWith("Refused:")) throw new Error(swapped);
  if (typeof swapped !== "string" || !swapped.includes("DRY RUN")) {
    throw new Error("expected a dry-run swap receipt, got: " + swapped);
  }
  log(indent(swapped));
}

log("\nNL › \"swap 0.1 MON for USDC\" (phrase parser, no model)");
{
  const parsed = parseAction("swap 0.1 MON for USDC");
  log("  parsed:       " + JSON.stringify(parsed));
  if (parsed.action !== "swap") throw new Error("expected swap phrase to parse, got " + JSON.stringify(parsed));
}

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
  const step = resolveSend(action);
  if (!step.ok) throw new Error("model-driven action was refused: " + step.reason);
  const out = await runAction(action, step.recipient);
  if (typeof out === "string" && out.startsWith("Refused:")) throw new Error(out);
  if (out != null) log("  result:       " + indent(out).trim());
}

await brain.unloadBrain();
wallet.dispose();
// QVAC's Bare worker can retain native child-process/socket handles after the SDK cleanup
// round-trip. This is a one-shot smoke command, so terminate explicitly after the success
// marker has been flushed instead of leaving CI or a terminal waiting on a worker that has
// already completed.
await flushSmokeSuccess();
