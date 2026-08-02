# CLAUDE.md — nad-agent

> MOST contributors: read https://most.devnads.com/agents.md before opening an issue or a PR here.

Context for Claude Code working in this repo. **nad-agent** is a 100% local AI agent with a
gasless, self-custodial WDK smart wallet on Monad: QVAC (a local LLM) turns natural language into
wallet actions; WDK executes them on Monad (gasless via a Pimlico paymaster, or dry-run).

## Conventions — do NOT change (deliberate; we hit the failure modes)
- **Use `npm`** — not pnpm/yarn (the lockfile + overrides assume npm).
- **Node ≥ 22.17** (QVAC requires it).
- **Do NOT add a global `sodium-native` override to `package.json`.** WDK wants pure-JS sodium, but
  QVAC's Bare worker needs the *native* one. The split is a **bundle-scoped esbuild alias** in
  `scripts/build.mjs` — leave `build.mjs` as-is.
- **`dist/` is gitignored** and built per-machine. Run `npm run build` after pulling or editing
  `src/`; `npm start`/`npm run smoke` execute the *built* `dist/`, not `src/`.
- **`.env` and `models/` are gitignored** — never commit secrets or model weights.
- Commit as the repo owner using the GitHub **noreply email** (avoids the GH007 email-privacy block).

## Run it
```
npm install
npm run gen-seed            # 24-word seed → paste into .env as WDK_SEED
cp .env.example .env
npm run build
npm run doctor              # preflight: platform, deps, env, model
npm run smoke               # non-interactive e2e (wallet + model + dry-run) → prints SMOKE_OK
npm start                   # interactive REPL
```

## Model guidance
- **Default is `QWEN3_8B_INST_Q4_K_M`** (ChatML). Any capable ChatML instruct model (Qwen3,
  Llama-3.x) runs fully on-device and drives the v0 JSON tool protocol coherently.
- **Avoid `GPT_OSS_20B` via `QVAC_MODEL_PATH`** — gpt-oss is *harmony*-only; loading it from a local
  `.gguf` skips the harmony template → gibberish. Use the QVAC **registry** name for gpt-oss, or a
  ChatML model.
- **Model download:** the QVAC registry uses P2P with a hard 60s timeout. On a slow/NAT'd host,
  fetch the GGUF over HTTPS instead: `node scripts/fetch-model.mjs <hf-url>`, then point
  `QVAC_MODEL_PATH` at the file.

## Gotchas (learned the hard way — see BUILD_LOG.md)
- **ERC-4337 tx hashes:** `account.sendTransaction()` returns the *userOpHash*, NOT the on-chain tx
  hash. `wallet.mjs` resolves the real `transactionHash` from the userOp receipt
  (`getUserOperationReceipt`) — keep that when touching the send path.
- **macOS only:** QVAC's darwin-arm64 prebuild links Homebrew's OpenSSL 3
  (`brew install openssl@3`), or the worker aborts on `dlopen … libssl.3.dylib`. Not needed on Linux.
- **QVAC's worker inherits `stdin`** → readline is created *after* the model loads; piped stdin is
  unreliable, so use `npm run smoke` for automation.
- Generation is capped by `QVAC_MAX_TOKENS` (default 256) with `temp=0`. Qwen3 emits `<think>…`
  before answering — raise the cap for complex multi-step prompts.

## Architecture
- `src/config.mjs` — env → resolved config (the only machine-specific behavior)
- `src/wallet.mjs` — WDK Safe ERC-4337 account on Monad (+ dry-run + tx-hash resolution)
- `src/agent.mjs` — QVAC: load / stream / unload the local model
- `src/addressBook.mjs` — recipient resolution: alias → address, validation, refusals
- `src/tools.mjs` — wallet actions + NL→action interpreter (v0 JSON protocol)
- `src/cli.mjs` — the interactive REPL / TUI
- `scripts/` — doctor · gen-seed · fetch-model · build

## Scope & roadmap
v0 actions: `get_address`, `get_balance`, `send` (native MON only). No tokens/swaps/bridges/NFTs
yet; single account. **Upgrade path:** swap `src/tools.mjs` for QVAC native tool-calling
(`completion({ tools })`) or the `@tetherto/wdk-mcp-toolkit` MCP server (35 tools). See README.
