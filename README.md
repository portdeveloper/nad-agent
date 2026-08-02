# nad-agent

**A 100% local AI agent with its own gasless, self-custodial wallet on Monad — powered end-to-end by Tether's stack (QVAC + WDK).**

No cloud. No API keys for the model. No gas for the user. You type in natural language, a model running *on your machine* decides what to do, you confirm, and the transaction settles on Monad — sponsored by a paymaster so the wallet pays zero gas.

```
you ──▶ QVAC (local LLM, on-device) ──▶ picks a wallet action ──▶ you confirm
                                                                      │
                                            WDK smart account (ERC-4337, Safe) ──▶ Monad
                                                                      │
                                              Pimlico bundler + paymaster (gasless)
```

- **Brain:** [QVAC](https://qvac.tether.io) runs a GGUF model fully on-device (CPU, or Metal on Apple Silicon).
- **Wallet:** [WDK](https://tether.io) derives a self-custodial Safe ERC-4337 account; the key never leaves the machine.
- **Chain:** Monad (EVM-equivalent) — fast, cheap settlement. Gasless via Pimlico.

---

## What it can do

Talk to it in plain English (or use the slash-commands) and it drives a real wallet on Monad:

- **`what's my address?`** → the agent's smart-account address
- **`what's my balance?`** → live MON balance, read from Monad
- **`what's my USDC balance?`** → ERC-20 balance read by known testnet symbol or token address
- **`send 0.1 MON to 0x…`** → asks you to confirm, then broadcasts a **gasless** transfer (the wallet pays 0 gas) and returns the on-chain tx hash + explorer link
- **`send 0.1 MON to alice`** → resolves the name through your local address book and shows the address it resolved to *before* you confirm
- anything else → the local model just replies in words

It all runs **on-device**: the model never calls the cloud, and the wallet key never leaves the machine.

**Scope (v0):** native MON sends plus read-only ERC-20 balance checks — `get_address`, `get_balance`, `get_token_balance`, `send`. No ERC-20 transfers, swaps, bridges, NFTs, or arbitrary contract calls yet; single account; testnet-first. It's a working proof-of-concept of a *local agentic wallet*, not a full DeFi suite — the [Upgrade path](#upgrade-path-bigger-agent) grows the toolset.

---

## Address book

Monad has no name service yet, so names resolve through `address-book.json`, a file you own,
sitting next to `.env`:

```json
{
  "alice": "0x1111111111111111111111111111111111111111",
  "treasury": "0x2222222222222222222222222222222222222222"
}
```

Point `NAD_ADDRESS_BOOK` elsewhere if you like. With no file you have no aliases and raw `0x…`
addresses behave exactly as before. The file is gitignored — not a secret like a seed, but it is
the list of who you pay, and anyone who can edit it can change where your sends go.

The confirm step always shows the address behind a name, because that is what gets signed:

```
Send 0.1 MON -> 0x8ba1f109551bD432803012645Ac136ddd64DBA72  (alias: alice)  (DRY RUN — will be simulated)
confirm? [y/N]
```

Resolution refuses rather than guesses. An unknown name, an entry whose address is malformed, or
one name spelled two ways (`alice` and `Alice`) with two different addresses are each reported and
the send is declined — a wrong recipient is not recoverable. A key repeated verbatim is JSON's own
business: `{"alice": A, "alice": B}` means B, and the parser settles it before we see the file.

---

## Develop on one machine, run on another

This is the intended workflow, and it works because **code travels via git while native dependencies do not**:

| What | In git? | Why |
|------|:------:|-----|
| Source (`src/`, `scripts/`) | ✅ | Platform-independent |
| `node_modules/` (incl. QVAC's native engine) | ❌ | Each machine runs `npm install` → gets its own prebuild (CPU vs Metal) |
| `.env` | ❌ | Model, keys, gas mode differ per machine (commit only `.env.example`) |
| Model weights (`.gguf`) | ❌ | Downloaded per machine |

So: edit + commit on your dev box (tiny CPU model, dry-run sends), `git push`; then on your Mac `git pull && npm install` (grabs the Metal build) and run the big model with real gasless sends. **Same code, different env vars.**

---

## Run it (on your Mac — the real deal)

```bash
git clone <this repo> && cd nad-agent
npm install                 # pulls the darwin-arm64 (Metal) QVAC prebuild
npm run gen-seed            # generates a 24-word seed
cp .env.example .env        # then paste the seed into WDK_SEED
npm run build               # esbuild bundles WDK (see "Build step" below)
npm run doctor              # sanity-check platform, deps, env, model
npm run smoke               # non-interactive end-to-end check (wallet + model + dry-run)
npm start                   # loads the local model + wallet, opens the prompt
```

> **macOS prerequisite:** QVAC's darwin-arm64 prebuild dynamically links Homebrew's OpenSSL 3. If
> the model load aborts with `dlopen … libssl.3.dylib … (no such file)`, install it once with
> `brew install openssl@3`.

Recommended `.env` on an M4 Max (36 GB):

```ini
WDK_SEED="…24 words…"
MONAD_NETWORK=testnet                 # or mainnet: red banner + one-time real-funds acknowledgement before the first send
QVAC_MODEL=QWEN3_8B_INST_Q4_K_M       # ChatML instruct — verified tool-calling on Metal
QVAC_CTX_SIZE=8192
# PIMLICO_API_KEY=…                   # leave blank to dry-run; set to broadcast real txs
# PIMLICO_SPONSORSHIP_POLICY_ID=sp_…  # set for truly gasless (wallet pays 0)
```

> **Model choice:** any capable **ChatML** instruct model (Qwen3, Llama-3.x, …) works from a local
> `.gguf` out of the box. `Qwen3-8B` is the tested default here — ~34 tok/s decode on an M4 Max.
> **Heads-up on `GPT_OSS_20B`:** gpt-oss is *harmony*-only; loading it from a local file
> (`QVAC_MODEL_PATH`) skips the harmony template and it emits gibberish. Use the QVAC **registry**
> name for it (so QVAC applies harmony), or stick with a ChatML model. See [BUILD_LOG.md](./BUILD_LOG.md).

Then talk to it:

```
› what's my address?
› what's my balance?
› send 0.1 MON to 0xABCD…            # asks you to confirm, then broadcasts (or dry-runs)
```

Or use the reliable slash-commands (no model needed): `/address` `/balance` `/balance <token>` `/send <to> <mon>` `/config` `/help` `/exit`.

---

## Gasless vs dry-run (no key needed to start)

- **No `PIMLICO_API_KEY`** → **dry-run**: the full loop runs (model → action → confirm) and sends are *simulated*. Reads (address, balance) are real. Perfect for building before your key lands.
- **`PIMLICO_API_KEY` set** → sends broadcast for real via ERC-4337. Add a **`PIMLICO_SPONSORSHIP_POLICY_ID`** to make them **gasless** (the paymaster funds gas). Get both at <https://dashboard.pimlico.io>.

Flipping between these is a one-line `.env` change — no code change.

## Build step

`npm run build` (esbuild) exists for one reason: WDK internally uses a *named* import from a CommonJS module (`sodium-universal`), which Node's plain ESM loader rejects. esbuild rewrites it, and the `sodium-native → sodium-javascript` override in `package.json` keeps the crypto path pure-JS (no native build). QVAC stays external and loads its per-platform prebuild at runtime.

## On a slow/CI dev box

QVAC's P2P registry has a hard 60s download timeout that a slow host can't beat for a big model. Work around it by fetching the GGUF over HTTPS and pointing at it directly:

```bash
node scripts/fetch-model.mjs <gguf-url>   # downloads into ./models
# then set QVAC_MODEL_PATH=/abs/path/to/model.gguf in .env
```

## Upgrade path (bigger agent)

v0 uses a model-agnostic JSON-action protocol so it works even on a 360M dev model. On a capable model you can swap `src/tools.mjs` for either QVAC's **native tool-calling** (`completion({ tools:[…] })`) or the official **[`@tetherto/wdk-mcp-toolkit`](https://www.npmjs.com/package/@tetherto/wdk-mcp-toolkit)** MCP server (35 wallet tools — balance/send/swap/bridge/lending), which plugs straight into QVAC via `completion({ mcp:[…] })`. Register Monad with `server.registerWallet("monad", WalletManagerEvm, { provider })`.

## Verified

Smoke-tested on Linux arm64 (CPU) with SmolLM2-360M in dry-run: WDK derives its Safe
account and reads balances from Monad testnet; QVAC loads the local model (~1.8s) and
turns "send 0.05 MON to 0x…" into a JSON action that runs as a dry-run send. See
[BUILD_LOG.md](./BUILD_LOG.md) for the failures hit along the way and their fixes.

Also verified on an **M4 Max (36 GB, Metal)** with **Qwen3-8B-Instruct (Q6_K)**: coherent
natural-language tool-calling at ~34 tok/s, a live balance read from Monad testnet, and the full
dry-run loop. Real gasless sending is wired up and Pimlico's bundler/paymaster is confirmed live on
Monad testnet; sends report the **real on-chain tx hash** — resolved from the ERC-4337 UserOperation
receipt, not the userOpHash. A `FIELD-REPORT-m4max.md` in the repo logs the full macOS bring-up.

**Known limitation:** QVAC's worker inherits `stdin`, so the interactive REPL only
handles reliably-typed TTY input — piped/scripted stdin is flaky. For automation use
`npm run smoke` (no readline). Verify interactive use on your Mac.

## Contributing

It's a v0 with on-purpose gaps. Grab a [`good first issue`](https://github.com/portdeveloper/nad-agent/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22),
read [CONTRIBUTING.md](./CONTRIBUTING.md) for setup and the conventions that aren't up for debate, and
open a PR. Security bugs go through [SECURITY.md](./SECURITY.md), not public issues.

## Layout

```
src/config.mjs       env → resolved config (the only machine-specific behavior)
src/wallet.mjs       WDK Safe ERC-4337 account on Monad (+ dry-run)
src/agent.mjs        QVAC local model: load / stream / unload
src/addressBook.mjs  recipient resolution: alias → address
src/tools.mjs        wallet actions + NL→action interpreter
src/tokens.mjs       built-in ERC-20 token symbols for balance reads
src/cli.mjs          the REPL
scripts/             doctor · gen-seed · fetch-model · build
```
