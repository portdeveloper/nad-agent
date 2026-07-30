/**
 * nad-agent CLI — a local AI agent that holds a gasless WDK wallet on Monad.
 *
 * Flow:  you type  ->  QVAC (local model) picks a wallet action  ->  you confirm
 *        writes  ->  WDK executes on Monad (gasless via Pimlico, or dry-run).
 *
 * Reliable slash-commands bypass the model entirely:
 *   /address           show the agent's wallet address
 *   /balance           show MON balance
 *   /send <to> <mon>   send MON (asks for confirmation)
 *   /config /help /exit
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

// Created in main() AFTER the model loads. QVAC spawns a Bare worker that inherits
// fd 0/1, and a readline built before that would swallow buffered input during the
// (multi-second) model load, so we defer it until the prompt is actually ready.
let rl;
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
  const row = (label, value) => console.log("   " + c.dim(label.padEnd(8)) + value);
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
  console.log("");
  LOGO.forEach((line, i) => {
    const logo = COLOR ? `\x1b[${GRAD[i]}m${line}\x1b[0m` : line;
    console.log("  " + logo + "   " + aside[i]);
  });
  console.log("");
  // The two stars — both Tether. QVAC does the thinking, WDK holds the keys.
  // QVAC tagline is its own positioning (qvac.tether.io): "Decentralized, Local AI".
  const metalBit = METAL ? " on your Metal GPU" : "";
  console.log("  " + c.qvac("⚡ Tether QVAC") + c.dim(" — Decentralized, Local AI · thinks on-device" + metalBit + ", no cloud"));
  console.log("  " + c.wdk("◆ Tether WDK") + c.dim("  — self-custodial smart wallet · your keys never leave this device"));
  console.log("");
  statusBlock();
  if (config.isMainnet) {
    const tail =
      config.gasMode === "dry-run"
        ? c.dim("gas mode is dry-run, sends are simulated.")
        : c.red("sends move real MON.");
    console.log("");
    console.log("  " + c.red(c.bold("⚠ MAINNET")) + c.dim(" — real funds. ") + tail);
  }
  console.log("");
}

// One explicit acknowledgement per session before the FIRST real-fund write on
// mainnet (dry-run stays friction-free — those sends are simulated anyway).
let mainnetAcked = false;

async function confirmMainnetOnce() {
  if (!config.isMainnet || config.gasMode === "dry-run" || mainnetAcked) return true;
  console.log("  " + c.red(c.bold("MAINNET")) + c.yellow(" — this will move real MON."));
  const ans = (await rl.question(c.yellow("  type ") + c.bold("mainnet") + c.yellow(" to acknowledge for this session: "))).trim().toLowerCase();
  if (ans !== "mainnet") return false;
  mainnetAcked = true;
  return true;
}

async function confirm(question) {
  const ans = (await rl.question(c.yellow(question + " ") + c.dim("[y/N] "))).trim().toLowerCase();
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
  }
  return true;
}

async function handleSlash(line) {
  const [cmd, ...rest] = line.slice(1).trim().split(/\s+/);
  switch (cmd) {
    case "address":
      return handleAction({ action: "get_address" });
    case "balance":
      return handleAction({ action: "get_balance" });
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
          "  " + c.cyan("/balance") + c.dim("           MON balance") + "\n" +
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
  banner();

  // 1) Wallet — reads work with just an RPC; writes need Pimlico (else dry-run).
  process.stdout.write(c.dim("   ") + c.violet("WDK") + c.dim(" · initializing wallet… "));
  try {
    const addr = await wallet.initWallet();
    console.log(c.green("ok"));
    console.log("   " + c.dim("address ") + c.addr(addr));
    try {
      const bal = await wallet.getBalance();
      const { formatMon } = await import("./format.mjs");
      console.log("   " + c.dim("balance ") + c.green(`${formatMon(bal)} ${config.chain.symbol}`));
    } catch {
      /* balance read is best-effort at startup */
    }
  } catch (err) {
    console.log(c.red("FAILED") + `\n   ${err.message}\n`);
    rl?.close();
    process.exit(1);
  }

  // 2) Local brain — QVAC loads the model into memory (on-device, no cloud).
  const modelName = config.model.localPath ? config.model.localPath.split("/").pop() : config.model.name;
  process.stdout.write(c.dim("   ") + c.qvac("QVAC") + c.dim(` · loading ${modelName}${METAL ? " on Metal" : ""}… `));
  const t0 = process.hrtime.bigint();
  try {
    await brain.loadBrain();
    const secs = Number(process.hrtime.bigint() - t0) / 1e9;
    console.log(c.green("ok") + c.dim(` (${secs.toFixed(1)}s)`));
  } catch (err) {
    console.log(c.red("FAILED") + `\n   ${err.message}`);
    console.log(c.dim("   (you can still use slash-commands; NL requests need the model)") + "\n");
  }

  console.log(
    "\n   " + c.dim("type ") + c.cyan("/help") + c.dim(" for commands, or just talk to it. ") + c.dim("Ctrl-C to quit.") + "\n"
  );

  // Create readline now — after the model load — so it doesn't discard buffered input.
  rl = createInterface({ input: stdin, output: stdout });

  const history = [{ role: "system", content: systemPrompt() }];

  let closed = false;
  rl.on("close", () => {
    closed = true;
  });

  for (;;) {
    if (closed) break;
    let line;
    try {
      line = (await rl.question(c.prompt("❯ "))).trim();
    } catch {
      break; // readline closed (Ctrl-D / EOF / piped input ended)
    }
    if (!line) continue;

    if (line.startsWith("/")) {
      const r = await handleSlash(line);
      if (r === "exit") break;
      continue;
    }

    // Natural language -> ask the local model for an action. The model's raw output
    // (thinking + JSON) streams dimmed; the executed result prints bright below it.
    history.push({ role: "user", content: line });
    process.stdout.write("  " + DIM);
    let raw = "";
    try {
      raw = await brain.complete(history, (t) => process.stdout.write(t));
      process.stdout.write(RST + "\n");
    } catch (err) {
      process.stdout.write(RST);
      console.log(c.red(`  model error: ${err.message}`) + "\n");
      continue;
    }
    history.push({ role: "assistant", content: raw });

    const action = parseAction(raw);
    const handled = await handleAction(action);
    if (!handled) console.log(""); // model chose to just chat; its text already streamed
  }

  await brain.unloadBrain().catch(() => {});
  wallet.dispose();
  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
