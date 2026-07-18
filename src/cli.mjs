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
import * as wallet from "./wallet.mjs";
import * as brain from "./agent.mjs";
import {
  ACTIONS,
  systemPrompt,
  parseAction,
  runAction,
  describeAction,
  isWrite,
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

/** Execute a parsed action, confirming writes. Returns nothing (prints results). */
async function handleAction(action) {
  if (action.action === "none") return false;
  if (isWrite(action.action)) {
    console.log("\n  " + c.yellow(describeAction(action)));
    if (!(await confirmMainnetOnce())) {
      console.log(c.dim("  cancelled.") + "\n");
      return true;
    }
    if (!(await confirm("  confirm?"))) {
      console.log(c.dim("  cancelled.") + "\n");
      return true;
    }
  }
  try {
    const out = await runAction(action);
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
      return handleAction({ action: "send_mon", to: rest[0], amountMon: rest[1] });
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
          "  " + c.cyan("/config") + c.dim("  ·  ") + c.cyan("/help") + c.dim("  ·  ") + c.cyan("/exit") + "\n\n" +
          "  " + c.dim("or just talk — ") + c.qvac("QVAC") + c.dim(" turns it into an action: ") + c.gray('"send 0.1 MON to 0x…"') + "\n"
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
