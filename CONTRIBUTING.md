# Contributing to nad-agent

## How work lands

All changes go through a pull request, and every pull request needs an approving
review from @portdeveloper before it can merge. Direct pushes to the default
branch are turned off. A merge means the work was read and accepted, not just
that it was opened.

Thanks for looking. nad-agent is a proof-of-concept: a 100% local AI agent with a gasless,
self-custodial WDK smart wallet on Monad, with QVAC as the on-device brain. It's a v0 on purpose, so
there's plenty of real work to pick up.

## Where to start

The [open issues](https://github.com/portdeveloper/nad-agent/issues) are the on-purpose gaps. Anything
labelled `good first issue` is scoped small and safe to land as a first PR (token balance reads, name
resolution, a `/history` command, a mainnet toggle, richer send confirmation). Comment on an issue to
claim it before you start so two people don't build the same thing. One claimed issue per person at
a time, across all pool repos, agent or not: claiming a second issue while you already hold one voids
all of your claims, and a claim with no PR or progress update for 7 days gets released so someone
else can take it. If you contribute with an AI agent, the agent must read and follow
<https://most.devnads.com/agents.md>: wait for a maintainer's go-ahead before writing code, one PR
per day.

## Setup

```bash
git clone https://github.com/portdeveloper/nad-agent && cd nad-agent
npm install                 # pulls the QVAC prebuild for your platform
npm run gen-seed            # generates a 24-word seed
cp .env.example .env        # paste the seed into WDK_SEED
npm run build               # esbuild bundles WDK into dist/
npm run doctor              # checks platform, deps, env, model
npm run smoke               # non-interactive end-to-end (wallet + model + dry-run)
npm start                   # interactive REPL
```

You can build the whole thing without a Pimlico key. With no `PIMLICO_API_KEY`, sends run as a
dry-run (simulated), while reads (address, balance) hit Monad for real. That's enough to develop
almost everything. See the README for the gasless vs dry-run details.

## Conventions that are not up for debate

These are deliberate. We hit the failure mode behind each one, so please don't "fix" them in a PR.

- **Use `npm`**, not pnpm or yarn. The lockfile and overrides assume npm.
- **Node >= 22.17.** QVAC requires it.
- **Don't add a global `sodium-native` override to `package.json`.** WDK wants pure-JS sodium, but
  QVAC's Bare worker needs the native one. The split is a bundle-scoped esbuild alias in
  `scripts/build.mjs`. Leave `build.mjs` alone unless your PR is specifically about it.
- **`dist/` is gitignored** and built per machine. Run `npm run build` after pulling or editing
  `src/`. `npm start` and `npm run smoke` run the built `dist/`, not `src/`.
- **Never commit `.env`, seeds, private keys, or model weights.** `.env` and `models/` are gitignored;
  keep it that way. Only `.env.example` is tracked.

`CLAUDE.md` has the longer version of all of this plus the architecture map, and `BUILD_LOG.md` logs
the failures we already hit so you don't have to rediscover them.

## Before you open a PR

- Run `npm run build` and `npm run smoke`. Smoke should print `SMOKE_OK`.
- Keep v0 scope in mind: native MON only, single account, testnet-first. If your change grows the
  scope (tokens, swaps, NFTs, multiple accounts), that's welcome, but say so in the PR so reviewers
  know what surface changed.
- Match the surrounding code. Small, focused PRs land faster than big ones.
- If you touch the send path, remember `account.sendTransaction()` returns the userOpHash, not the
  on-chain tx hash. `wallet.mjs` resolves the real hash from the UserOperation receipt. Keep that.

## PRs and commits

Open a PR against `main`, link the issue it closes, and describe what you tested (dry-run, real
gasless send, which model). If you tested on a Mac with a real send, a tx hash in the PR is gold.

That's it. Go try it and contribute, i added too few features on purpose.
