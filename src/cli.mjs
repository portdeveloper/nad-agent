/**
 * nad-agent CLI — a local AI agent that holds a gasless WDK wallet on Monad.
 *
 * Flow:  you type  ->  QVAC (local model) picks a wallet action  ->  you confirm
 *        writes  ->  WDK executes on Monad (gasless via Pimlico, or dry-run).
 *
 * Reliable slash-commands bypass the model entirely:
 *   /address           show the agent's wallet address
 *   /balance [token]   show native MON or ERC-20 token balance
 *   /send <to> <mon>   send MON (asks for confirmation)
 *   /swap <amt> <in> <out>  swap tokens on PuddleSwap (asks for confirmation)
 *   /account [index]   list or switch derived account
 *   /config /help /exit
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

// Created in main() AFTER the model loads. QVAC spawns a Bare worker that inherits
// fd 0/1, and a readline built before that would swallow buffered input during the
// (multi-second) model load, so we defer it until the prompt is actually ready.
let rl;

// ── scripted (non-TTY) mode ─────────────────────────────────────────────────
// QVAC's worker inherits fd 0, so piped input used to race the REPL (BUILD_LOG
// §4). In scripted mode we drain stdin to EOF *before* the worker ever spawns,
// then feed the buffered lines through the same dispatch as the interactive
// REPL. Prompts, banner and progress go to stderr so stdout stays machine-clean;
// confirmations consume the next scripted line, preserving REPL semantics
// (`printf '/send 0xdead 0.1\ny\n' | nad-agent`).
const SCRIPTED = !stdin.isTTY;
// Declarative spend policy (optional file). Loaded once at startup so a broken
// policy fails loudly before any send, and the session budget accumulates here.
let policy = null;
let sessionSpent = 0n;
let scriptLines = [];
let hadFailure = false;

async function readScriptLines() {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks)
    .toString("utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

// One question surface for both modes: interactive readline, or the next
// scripted line (echoed to stderr so transcripts read like a session).
async function ask(promptText) {
  if (!SCRIPTED) return (await rl.question(promptText)).trim();
  const answer = scriptLines.length ? scriptLines.shift() : "";
  process.stderr.write(promptText + (answer || "<no answer line>") + "\n");
  return answer;
}

// println: stdout in interactive mode, stderr in scripted mode (results only
// belong on stdout there).
const println = (...a) => (SCRIPTED ? console.error(...a) : console.log(...a));
const printw = (s) => (SCRIPTED ? process.stderr.write(s) : process.stdout.write(s));

import { config } from "./config.mjs";
import { parseMon } from "./format.mjs";
import { loadPolicy, hasRules } from "./policy.mjs";
import * as wallet from "./wallet.mjs";
import * as brain from "./agent.mjs";
import { addressBookWarnings, formatRecipient, safeEcho } from "./addressBook.mjs";
import {
  ACTIONS,
  systemPrompt,
  parseAction,
  runAction,
  describeAction,
  isWrite,
  previewSend,
  renderSendPreview,
  resolveSend,
  parseAccountIndex,
  needsRecipient,
  buildSwapPreview,
  lockSwapRoute,
  parseSwapConfirm,
} from "./tools.mjs";

// ── color (no deps) ─────────────────────────────────────────────────────────
// Gated on a real TTY + respects NO_COLOR, so piped/CI output stays clean text.
const COLOR = !!stdout.isTTY && process.env.NO_COLOR == null;
const sgr = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : `${s}`);
const c = {
  violet: sgr("38;5;141"),
  purple: sgr("38;5;99"),
  green: sgr("38;5;42"),
  cyan: sgr("38;5;80"),
  yellow: sgr("38;5;179"),
  red: sgr("38;5;203"),
  gray: sgr("38;5;245"),
  dim: sgr("2"),
  bold: sgr("1"),
  addr: sgr("1;38;5;81"), // bold cyan
  prompt: sgr("1;38;5;141"),
  qvac: sgr("1;38;5;37"), // bold teal — QVAC (the AI)
  wdk: sgr("1;38;5;141"), // bold violet — WDK (the wallet)
};
const DIM = COLOR ? "\x1b[2m" : "";
const RST = COLOR ? "\x1b[0m" : "";
// On Apple Silicon QVAC uses the Metal GPU; elsewhere just say "on-device".
const METAL = process.platform === "darwin" && process.arch === "arm64";

// "NAD" in ANSI-Shadow block letters; painted top-to-bottom in a violet gradient.
const LOGO = [
  "███╗   ██╗ █████╗ ██████╗ ",
  "████╗  ██║██╔══██╗██╔══██╗",
  "██╔██╗ ██║███████║██║  ██║",
  "██║╚██╗██║██╔══██║██║  ██║",
  "██║ ╚████║██║  ██║██████╔╝",
  "╚═╝  ╚═══╝╚═╝  ╚═╝╚═════╝ ",
];
const GRAD = ["38;5;189", "38;5;147", "38;5;141", "38;5;99", "38;5;99", "38;5;61"];

function statusBlock() {
  const g = config.gasMode;
  const dot = g === "sponsored" ? c.green("●") : g === "dry-run" ? c.yellow("●") : c.cyan("●");
  const gas =
    g === "sponsored"
      ? c.green("gasless") + c.dim(" · you pay 0 gas")
      : g === "dry-run"
        ? c.yellow("dry-run") + c.dim(" · sends are simulated")
        : c.cyan("native") + c.dim(" · you pay gas in MON");
  const model = config.model.localPath ? config.model.localPath.split("/").pop() : config.model.name;
  const row = (label, value) => println("   " + c.dim(label.padEnd(8)) + value);
  // Engine first — QVAC is the whole point.
  row("engine", c.qvac("Tether QVAC") + c.dim(" · on-device inference" + (METAL ? " · Metal GPU" : "")));
  row("model", c.cyan(model));
  row("wallet", c.violet("Tether WDK") + c.dim(" · self-custodial Safe ERC-4337"));
  row(
    "network",
    (config.isMainnet ? c.red(c.bold(config.chain.name)) : c.violet(config.chain.name)) +
      c.dim(` · chainId ${config.chain.chainId}`),
  );
  row("rpc", c.gray(config.chain.rpcUrl));
  row("gas", `${dot} ${gas}`);
}

function banner() {
  const aside = ["", "", c.violet(c.bold("· agent")), "", c.gray("self-custodial wallet · settles on Monad"), ""];
  println("");
  LOGO.forEach((line, i) => {
    const logo = COLOR ? `\x1b[${GRAD[i]}m${line}\x1b[0m` : line;
    println("  " + logo + "   " + aside[i]);
  });
  println("");
  // The two stars — both Tether. QVAC does the thinking, WDK holds the keys.
  // QVAC tagline is its own positioning (qvac.tether.io): "Decentralized, Local AI".
  const metalBit = METAL ? " on your Metal GPU" : "";
  println("  " + c.qvac("⚡ Tether QVAC") + c.dim(" — Decentralized, Local AI · thinks on-device" + metalBit + ", no cloud"));
  println("  " + c.wdk("◆ Tether WDK") + c.dim("  — self-custodial smart wallet · your keys never leave this device"));
  println("");
  statusBlock();
  if (config.isMainnet) {
    const tail =
      config.gasMode === "dry-run"
        ? c.dim("gas mode is dry-run, sends are simulated.")
        : c.red("sends move real MON.");
    println("");
    println("  " + c.red(c.bold("⚠ MAINNET")) + c.dim(" — real funds. ") + tail);
  }
  println("");
}

// One explicit acknowledgement per session before the FIRST real-fund write on
// mainnet (dry-run stays friction-free — those sends are simulated anyway).
let mainnetAcked = false;

async function confirmMainnetOnce() {
  if (!config.isMainnet || config.gasMode === "dry-run" || mainnetAcked) return true;
  console.log("  " + c.red(c.bold("MAINNET")) + c.yellow(" — this will move real MON."));
  const raw = await ask(c.yellow("  type ") + c.bold("mainnet") + c.yellow(" to acknowledge for this session: "));
  if (SCRIPTED && raw === "") hadFailure = true;
  if (raw.toLowerCase() !== "mainnet") return false;
  mainnetAcked = true;
  return true;
}

// The prompt itself carries the network: a persistent mainnet marker survives
// scrollback where the startup banner does not.
const REPL_PROMPT = config.isMainnet ? c.red(c.bold("mainnet ")) + c.prompt("❯ ") : c.prompt("❯ ");

async function confirm(question) {
  const raw = await ask(c.yellow(question + " ") + c.dim("[y/N] "));
  if (SCRIPTED && raw === "") {
    println(c.red("  no answer line for the confirmation; cancelling this action."));
    hadFailure = true;
    return false;
  }
  const ans = raw.toLowerCase();
  return ans === "y" || ans === "yes";
}

/**
 * Swap confirm: y/yes takes the best route (index 0); a number 1..n picks that
 * listed route; anything else cancels. The chosen index is frozen — we do not
 * silently switch paths after this answer.
 */
async function confirmSwap(routeCount) {
  const hint = routeCount > 1 ? `[y = best / 1-${routeCount} / N]` : "[y/N]";
  const raw = await ask(c.yellow("  confirm? ") + c.dim(hint + " "));
  if (SCRIPTED && raw === "") {
    println(c.red("  no answer line for the confirmation; cancelling this action."));
    hadFailure = true;
    return null;
  }
  const picked = parseSwapConfirm(raw, routeCount);
  if (picked === null) return null;
  return picked;
}

/** Execute a parsed action, confirming writes. Returns nothing (prints results). */
async function handleAction(action) {
  let resolved = null;
  let swapPreview = null;
  if (action.action === "none") return false;
  if (isWrite(action.action)) {
    if (needsRecipient(action.action)) {
      // Resolve the recipient ONCE, before anything is shown, and hold it for the whole flow:
      // the address on screen is the address that gets signed, even if the address book changes
      // while the prompt is open. resolveSend covers a book name and a raw address alike, so it
      // replaces the inline checksum step this block used to do.
      const prep = resolveSend(action, { policy, sessionSpent });
      if (!prep.ok) {
        println(c.red(`  Refused: ${prep.reason}`) + "\n");
        if (SCRIPTED) hadFailure = true;
        return true;
      }
      resolved = prep.recipient;
    }

    if (action.action === "swap") {
      let preview;
      try {
        preview = await buildSwapPreview(action, { policy, sessionSpent });
      } catch (err) {
        println(c.red(`  Refused: ${err.message}`) + "\n");
        if (SCRIPTED) hadFailure = true;
        return true;
      }
      if (preview.error) {
        println(c.red(`  Refused: ${preview.error}`) + "\n");
        if (SCRIPTED) hadFailure = true;
        return true;
      }
      println("\n  " + c.yellow(preview.block.replace(/\n/g, "\n  ")));
      if (!(await confirmMainnetOnce())) {
        println(c.dim("  cancelled.") + "\n");
        return true;
      }
      const picked = await confirmSwap(preview.routes.length);
      if (picked === null) {
        println(c.dim("  cancelled.") + "\n");
        return true;
      }
      swapPreview = lockSwapRoute(preview, picked);
      if (swapPreview.error) {
        println(c.red(`  Refused: ${swapPreview.error}`) + "\n");
        if (SCRIPTED) hadFailure = true;
        return true;
      }
    } else if (action.action === "send_mon") {
      let preview;
      try {
        preview = await previewSend(action, resolved.address, { policy, sessionSpent });
      } catch (err) {
        println(c.red(`  Refused: ${err.message}`) + "\n");
        if (SCRIPTED) hadFailure = true;
        return true;
      }
      // Quoted against the bare address; shown with the alias beside it, so the operator
      // approves the same thing the book produced.
      const block = renderSendPreview({ ...preview, to: formatRecipient(resolved) });
      println("\n  " + c.yellow(block.replace(/\n/g, "\n  ")));
      if (!(await confirmMainnetOnce())) {
        println(c.dim("  cancelled.") + "\n");
        return true;
      }
      if (!(await confirm("  confirm?"))) {
        println(c.dim("  cancelled.") + "\n");
        return true;
      }
    } else {
      println("\n  " + c.yellow(describeAction(action, resolved)));
      if (!(await confirmMainnetOnce())) {
        println(c.dim("  cancelled.") + "\n");
        return true;
      }
      if (!(await confirm("  confirm?"))) {
        println(c.dim("  cancelled.") + "\n");
        return true;
      }
    }
  }
  // Account switch requires explicit confirmation (no on-chain recipient to resolve,
  // but the active account IS global mutable state — the operator must approve).
  if (action.action === "account" && action.index !== undefined && action.index !== null && action.index !== "") {
    // Validate the index before showing confirmation: an invalid index should
    // surface its refusal message, not a misleading "list accounts" description.
    const validated = parseAccountIndex(action.index);
    if (validated === null) {
      const safe = safeEcho(action.index, 40);
      println("\n  " + c.red(`Refused: "${safe}" is not a valid account index.`) + "\n");
      if (SCRIPTED) hadFailure = true;
      return true;
    }
    println("\n  " + c.yellow(describeAction(action)));
    if (!(await confirmMainnetOnce())) {
      println(c.dim("  cancelled.") + "\n");
      return true;
    }
    if (!(await confirm("  confirm?"))) {
      println(c.dim("  cancelled.") + "\n");
      return true;
    }
  }
  try {
    const out = await runAction(action, resolved, swapPreview ? { preview: swapPreview } : {});
    // Only native amounts count against the session budget; token amounts are
    // not denominated in MON, so the policy governs their recipient only. A
    // refusal from runAction must not consume budget, and a dry run does count:
    // the budget bounds what the agent attempts, not only what settles.
    if (action.action === "send_mon" && resolved && !String(out ?? "").startsWith("Refused:")) {
      sessionSpent += parseMon(action.amountMon);
    }
    if (action.action === "swap" && swapPreview?.nativeIn && !String(out ?? "").startsWith("Refused:")) {
      sessionSpent += parseMon(action.amountIn);
    }
    if (out != null) console.log("  " + c.cyan(out.replace(/\n/g, "\n  ")) + "\n");
  } catch (err) {
    console.log(c.red(`  error: ${err.message}`) + "\n");
    if (SCRIPTED) hadFailure = true;
  }
  return true;
}

async function handleSlash(line) {
  const [cmd, ...rest] = line.slice(1).trim().split(/\s+/);
  switch (cmd) {
    case "address":
      return handleAction({ action: "get_address" });
    case "balance":
      return rest.length
        ? handleAction({ action: "get_token_balance", token: rest.join(" ") })
        : handleAction({ action: "get_balance" });
    case "send":
      // Wrong arity gets the usage line, not a confusing refusal about
      // "undefined" being a bad address. Scripted mode still counts it as a
      // failure: a malformed /send in a script is a script bug, and the old
      // refusal path set the exit code too.
      if (rest.length !== 2) {
        // println, not console.log: the refusal this replaces went through the
        // same surface, and in scripted mode stdout must stay machine-clean.
        println(c.dim("  usage: /send <to> <mon>") + "\n");
        if (SCRIPTED) hadFailure = true;
        return true;
      }
      return handleAction({ action: "send_mon", to: rest[0], amountMon: rest[1] });
    case "account":
      return handleAction({ action: "account", index: rest[0] ?? undefined });
    case "swap":
      return handleAction({ action: "swap", amountIn: rest[0], tokenIn: rest[1], tokenOut: rest[2] });
    case "config":
      statusBlock();
      console.log("");
      return true;
    case "help":
      console.log(
        "\n  " + c.violet(c.bold("commands")) + "\n" +
          "  " + c.cyan("/address") + c.dim("           the agent's wallet address") + "\n" +
          "  " + c.cyan("/balance [token]") + c.dim("   native MON or ERC-20 balance") + "\n" +
          "  " + c.cyan("/send <to> <mon>") + c.dim("   send MON (asks you to confirm)") + "\n" +
          "  " + c.cyan("/account [index]") + c.dim("   list / switch derived account") + "\n" +
          "  " + c.cyan("/swap <amt> <in> <out>") + c.dim("  swap tokens on PuddleSwap") + "\n" +
          "  " + c.cyan("/config") + c.dim("  ·  ") + c.cyan("/help") + c.dim("  ·  ") + c.cyan("/exit") + "\n\n" +
          "  " + c.dim("or just talk — ") + c.qvac("QVAC") + c.dim(" turns it into an action: ") + c.gray('"swap 0.1 MON for USDC"') + "\n"
      );
      return true;
    case "exit":
    case "quit":
      return "exit";
    default:
      console.log(c.dim(`  unknown command: /${cmd} (try /help)`) + "\n");
      return true;
  }
}

async function main() {
  // Scripted mode: drain stdin to EOF before anything else. The QVAC worker
  // inherits fd 0 when it spawns; by then the input must already be ours.
  if (SCRIPTED) scriptLines = await readScriptLines();

  banner();

  // A malformed policy must stop the agent before any send, never be ignored.
  try {
    policy = loadPolicy();
  } catch (err) {
    println(c.red(`   policy: ${err.message}`) + "\n");
    process.exit(1);
  }
  if (hasRules(policy)) {
    println("   " + c.dim("policy  ") + c.yellow(`enforcing rules from ${policy.path}`));
  }

  // 1) Wallet — reads work with just an RPC; writes need Pimlico (else dry-run).
  printw(c.dim("   ") + c.violet("WDK") + c.dim(" · initializing wallet… "));
  try {
    const addr = await wallet.initWallet();
    println(c.green("ok"));
    println("   " + c.dim("address ") + c.addr(addr));
    try {
      const bal = await wallet.getBalance();
      const { formatMon } = await import("./format.mjs");
      println("   " + c.dim("balance ") + c.green(`${formatMon(bal)} ${config.chain.symbol}`));
    } catch {
      /* balance read is best-effort at startup */
    }
  } catch (err) {
    println(c.red("FAILED") + `\n   ${err.message}\n`);
    rl?.close();
    process.exit(1);
  }

  // 2) Local brain — QVAC loads the model into memory (on-device, no cloud).
  const modelName = config.model.localPath ? config.model.localPath.split("/").pop() : config.model.name;
  printw(c.dim("   ") + c.qvac("QVAC") + c.dim(` · loading ${modelName}${METAL ? " on Metal" : ""}… `));
  const t0 = process.hrtime.bigint();
  try {
    await brain.loadBrain();
    const secs = Number(process.hrtime.bigint() - t0) / 1e9;
    println(c.green("ok") + c.dim(` (${secs.toFixed(1)}s)`));
  } catch (err) {
    println(c.red("FAILED") + `\n   ${err.message}`);
    println(c.dim("   (you can still use slash-commands; NL requests need the model)") + "\n");
  }
  for (const w of addressBookWarnings()) println("   " + c.yellow("address book: ") + w);

  println(
    "\n   " + c.dim("type ") + c.cyan("/help") + c.dim(" for commands, or just talk to it. ") + c.dim("Ctrl-C to quit.") + "\n"
  );

  // One line through the same dispatch in both modes. Returns "exit" to stop.
  async function processLine(line, history) {
    if (line.startsWith("/")) {
      return await handleSlash(line);
    }

    // Natural language -> ask the local model for an action. The model's raw
    // output (thinking + JSON) streams dimmed to the conversational surface;
    // the executed result prints bright on stdout.
    history.push({ role: "user", content: line });
    printw("  " + DIM);
    let raw = "";
    try {
      raw = await brain.complete(history, (t) => printw(t));
      printw(RST + "\n");
    } catch (err) {
      printw(RST);
      println(c.red(`  model error: ${err.message}`) + "\n");
      if (SCRIPTED) hadFailure = true;
      return true;
    }
    history.push({ role: "assistant", content: raw });

    const action = parseAction(raw);
    const handled = await handleAction(action);
    if (!handled) println(""); // model chose to just chat; its text already streamed
    return true;
  }

  const history = [{ role: "system", content: systemPrompt() }];

  if (SCRIPTED) {
    // Scripted mode: no readline at all. Execute the buffered lines in order;
    // answer lines are consumed by ask() inside confirmations as they come up.
    while (scriptLines.length) {
      const line = scriptLines.shift();
      process.stderr.write(REPL_PROMPT + line + "\n");
      const r = await processLine(line, history);
      if (r === "exit") break;
    }
  } else {
    // Interactive mode: create readline now — after the model load — so it
    // doesn't discard buffered input.
    rl = createInterface({ input: stdin, output: stdout });

    let closed = false;
    rl.on("close", () => {
      closed = true;
    });

    for (;;) {
      if (closed) break;
      let line;
      try {
        line = (await rl.question(REPL_PROMPT)).trim();
      } catch {
        break; // readline closed (Ctrl-D / EOF)
      }
      if (!line) continue;
      const r = await processLine(line, history);
      if (r === "exit") break;
    }
  }

  await brain.unloadBrain().catch(() => {});
  wallet.dispose();
  rl?.close();
  if (SCRIPTED) {
    // The QVAC worker keeps the event loop alive; in scripted mode there is no
    // readline to close and end it, so exit explicitly once the script is done.
    process.exit(hadFailure ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
