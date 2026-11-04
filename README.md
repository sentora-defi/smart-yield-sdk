# Sentora SmartYield Documentation

Read-only vault state and **unsigned** transaction plans for Sentora-supported vault families, consumable as TypeScript libraries, a CLI (`smart-yield`), or an MCP server (`smart-yield-mcp`). The CLI and the MCP server never sign or broadcast: plans are handed to external signers as-is. The library `core` execute wrappers send transactions only through a viem `WalletClient` that the integrator passes in.

## Index

- [Concepts](#concepts)
- [Data sources](#data-sources)
- [Plans](#plans)
- [Installation & build](#installation--build)
- [Environment variables](#environment-variables)
- [Using as a library](#using-as-a-library)
- [Using the CLI (smart-yield)](#using-the-cli-smart-yield)
  - [Global options](#global-options)
  - [Commands](#commands)
  - [Plan output format](#plan-output-format)
  - [Exit codes](#exit-codes)
- [Using via MCP (smart-yield-mcp)](#using-via-mcp-smart-yield-mcp)
- [Testing](#testing)
- [License](#license)

## Concepts

- **Family SDKs** (`vaults-morpho`, `vaults-boring`, `vaults-upshift-financial`) share a three-layer design:
  - `encode`: pure calldata builders. No RPC, no signer. Return `TxStep`.
  - `plan`: read-only RPC preflight. Return an unsigned `Plan` (steps + expected outcomes + blockers/warnings).
  - `core`: reads (metadata, positions, previews, gates) plus execute wrappers for apps that hold a viem `WalletClient` (e.g. React hooks). Every write is simulated before sending, throws if the wallet is on another chain, and throws a `TransactionFailedError` (exported by `@sentora/vaults-plan`) if the wallet cancels or replaces it or its receipt status is `reverted`.
- **Plans are unsigned.** A plan with a non-empty `blockers` array must not be executed. See [Plans](#plans).
- **Amounts are `bigint`** in the library APIs and **decimal strings** everywhere they are serialized (plans, CLI, MCP): JSON-safe, no precision loss.
- All SDKs take viem clients and viem types (`Address`, `Hex`). `viem` is a peer dependency. Client parameters are typed with the few methods each layer calls (`ReadClient`, `WriteClient`, `SignerClient` from `@sentora/vaults-plan`), so a viem `PublicClient` or `WalletClient` for any chain fits, including OP-stack chains like Ink and zkSync chains.

## Data sources

Which package talks to what, and where each input comes from.

| Package | Talks to | Sentora API |
|---|---|---|
| `vaults-plan` | the RPC behind the client passed to `approveNeedsReset` and `sendSimulated`, and for `sendSimulated` the integrator's `WalletClient`; everything else is types and helpers | no |
| `vaults-morpho`, `vaults-boring`, `vaults-upshift-financial` | the RPC behind the integrator's read client (e.g. a viem `PublicClient`); for `core` writes, the integrator's `WalletClient` | no |
| `yields-client` | the Sentora yields API | yes, read-only |
| `vaults-cli`, `vaults-mcp` | the configured RPC and the Sentora yields API | yes, read-only |

**Family SDKs.** Their only dependencies are `viem` and `@sentora/vaults-plan`. They make no HTTP calls, read no environment variables and hold no chain or contract constants besides the zero address. Everything they need comes from the integrator or from the chain:

- From the integrator: the vault address, the owner/receiver, amounts, the read client (and so the RPC endpoint and chain), the `WalletClient` for `core` writes, the deposit asset for Boring, and the optional Boring `discoverConfig` overrides (`teller`, `queue`, `queues`, `fromBlock`, `skipQueueScan`).
- From the chain, through that read client: the chain ID (`getChainId()`), the vault's asset, decimals, gates, caps and pauses, and the Boring teller, accountant, queue and RolesAuthority (`discoverConfig`).

**yields-client.** The only package that calls the Sentora API. Every method is a read: 16 `GET` endpoints plus one `POST` (`getStrategyAllocationDistribution`) that sends its query in the request body and changes nothing. `listVaults()` (`GET /vaults`) returns the vault records, which include each vault's family and contract addresses.

**CLI and MCP.** Plan commands build their steps from the family SDKs only; no API response feeds calldata or a plan. API data reaches an on-chain call in two places. The first is `snapshot`: it takes the vault family from the API's vault record when the vault is listed on the RPC's chain (otherwise it detects the family on-chain), and for Boring vaults it takes the teller, accountant, queue, RolesAuthority and deposit token from that record. Those addresses are validated and used only for the read-only `preflight` and `getPosition` calls. The other is `upshift_evm pending-withdrawals`: it takes the block numbers of the owner's redemption requests from the API's activity and reads `getWithdrawalEpoch` at those blocks to date each claim (a block the RPC cannot read falls back to the request's timestamp and the current `lagDuration`, with a warning), then reads `getClaimable` for each resulting date. The CLI's RPC client uses the canonical Multicall3 address for read batching (`--no-multicall` turns it off).

## Plans

A plan is the SDK's central artifact: a complete, unsigned description of a vault action, produced entirely from read-only RPC calls and handed to whatever holds the keys: a browser wallet, a backend KMS, a Safe, an agent. Plan builders (`planDeposit`, `planRedeem`, `planRequestWithdraw`, `planClaim`, …) take only a `ReadClient` (any viem `PublicClient` fits) and cannot sign or broadcast, so a plan is inert data that is safe to log, persist, and move across process boundaries (SDK → CLI → agent → signing service). That is also why every amount in a serialized plan is a decimal string rather than a JSON-unsafe bigint.

How to execute a plan (check `blockers`, surface `warnings`, send `steps` in order, with a viem example) and how to read `expected` and `context` is in the [`@sentora/vaults-plan` README](packages/vaults-plan/README.md#plans), which ships with that package. The CLI-serialized form is shown in [Plan output format](#plan-output-format).

## Installation & build

```sh
npm install                # workspace root
npm run build              # all packages: CLI/MCP bundles + library dist (JS + .d.ts)
node packages/vaults-cli/dist/cli.mjs --help
```

Published package names: `@sentora/vaults-cli` (bin `smart-yield`), `@sentora/vaults-mcp` (bin `smart-yield-mcp`), `@sentora/vaults-{plan,morpho,boring,upshift-financial}`, `@sentora/yields-client`.

## Environment variables

The API key is env-only, never a flag. Flags override the other env values. `--rpc-url` is a flag, so if your RPC URL embeds a provider key, set it in `VAULTS_RPC_URL` instead, to keep it out of shell history and process listings.

| Variable | Purpose |
|---|---|
| `VAULTS_RPC_URL` (or `SENTORA_RPC_URL`, `ETH_RPC_URL`) | JSON-RPC endpoint for on-chain reads. Flag: `--rpc-url`. |
| `YIELDS_BASE_URL` (or `SENTORA_API_URL`) | Sentora yields API base URL. Default `https://services.vaults.sentora.com`. Flag: `--base-url`. |
| `YIELDS_API_KEY` (or `SENTORA_API_KEY`) | Sentora yields API key (`x-api-key` header). Env only. |

## Using as a library

The API reference of each library lives in its own README, which ships in the npm package:

| Package | What it is |
|---|---|
| [`@sentora/vaults-plan`](packages/vaults-plan/README.md) | The plan envelope, the client types (`ReadClient`, `WriteClient`, `SignerClient`) and the helpers the families share. |
| [`@sentora/vaults-morpho`](packages/vaults-morpho/README.md) | Morpho Vaults (V1 MetaMorpho and V2). |
| [`@sentora/vaults-boring`](packages/vaults-boring/README.md) | Veda BoringVaults (teller deposits, queue withdrawals, `discoverConfig`). |
| [`@sentora/vaults-upshift-financial`](packages/vaults-upshift-financial/README.md) | Upshift Financial TokenizedVaults. |
| [`@sentora/yields-client`](packages/yields-client/README.md) | Typed client for the Sentora yields API. |

The `yields-client` response types are generated from the API's OpenAPI spec in `packages/yields-client/openapi.json`: `npm run openapi:types` regenerates `packages/yields-client/src/openapi.ts`. A unit test fails if the two drift apart or if the test stub returns a field the spec does not document.

## Using the CLI (smart-yield)

```sh
smart-yield <family> <command> [--flags]   # family commands
smart-yield <command> [--flags]            # top-level: describe, detect, snapshot
```

Run `smart-yield describe` to dump the entire surface (families, commands, flags, examples, exit codes) as JSON; one call teaches the whole CLI. The CLI is strictly read-only: it plans, it never signs, sends, or broadcasts.

### Global options

| Flag | Default | Description |
|---|---|---|
| `--rpc-url <url>` | env | JSON-RPC endpoint (flag > `VAULTS_RPC_URL` > `SENTORA_RPC_URL` > `ETH_RPC_URL`). |
| `--output json\|text` | `json` | Compact JSON (bigints as strings) or `path=value` lines. |
| `--pretty` | off | Pretty-print JSON. |
| `--timeout <ms>` | `30000` | Per-request network timeout; `0` = no limit. |
| `--no-multicall` | off | Disable Multicall3 read batching. |
| `--verbose` | off | Diagnostics to stderr; stdout stays clean JSON. |
| `--help` | | Help for the CLI, a family or a command. |

`smart-yield --version` prints the version (first argument only). Amount-taking commands also accept `--human`: amounts are read as decimal token units (e.g. `100.5`) and scaled by the token's on-chain `decimals()`; the default is base units and other commands reject the flag.

On-chain amounts are decimal strings in base units. Plans add `expectedFormatted` when `expected` has values, and `morpho meta` / `upshift_evm meta` add `formatted`. `yields` commands return the API's data, where amounts are already token units or USD; only fields ending in `Raw` (`liveSharesRaw`, `dbSharesRaw`, `amountRaw`, `sharesRaw`) are base units. `yields list` wraps the vaults in a paged envelope, and `yields analytics --summary` / `--last` reshape the series. Other on-chain outputs carry only base units. Errors go to stderr as structured JSON: `{ "error": { code, message, retryable, hint? } }`.

### Commands

The tables below name each command's flags; for per-flag descriptions run `smart-yield <family> <command> --help` or `smart-yield describe`.

**Top-level**

| Command | Description |
|---|---|
| `describe [--family <f>]` | Full command surface as JSON (`schemaVersion`, env docs, exit codes, per-command flags/examples). |
| `detect --vault <addr>` | Probe a vault on-chain and classify its family (`morpho`/`boring`/`upshift_evm`); exit 3 if unknown. |
| `snapshot --vault <addr>[,<addr>…] [--owner <addr>] [--base-url <url>]` | One-call preflight per vault: family + meta (boring: `config` from the API vault record + preflight instead, see [Data sources](#data-sources)), plus gates/position when `--owner` is given. Batch-tolerant (per-vault `error` field). The API record is looked up on the RPC's chain; if that lookup fails, the item carries `catalogError` and the family falls back to on-chain detection. |

**`yields` (Sentora yields API)**

| Command | Required flags | Description |
|---|---|---|
| `yields list` | | Vault catalog from the API. Filters: `--featured --chain --family --curator --vendor`; shaping: `--limit --offset --fields`. |
| `yields get` | `--chain-id --address` | One vault. |
| `yields analytics` | `--chain-id --address` | Time series. Range: `--days` or `--since/--until`; shaping: `--metric`, `--last <n>`, `--summary` (reduce to `{points, from, to, latest, min, max, mean}`). |
| `yields risk` | `--chain-id --address` | Risk indicators. |
| `yields main-insights` | `--chain-id --address` | Supply/debt of the DeFi Risk market a direct vault lends into; empty `metric` and no `market` for vaults without one. |
| `yields balance` | `--chain-id --address --wallet` | Wallet balance in one vault. |
| `yields activity` | `--chain-id --address --wallet` | Wallet activity in one vault. |
| `yields positions` | `--wallet` | Cross-chain portfolio. |
| `yields blockchains` | | Supported chains. |

All `yields` commands accept `--base-url` (default: the production API; env `YIELDS_BASE_URL` or `SENTORA_API_URL` override).

**`morpho`**. On plan commands `--receiver` defaults to `--owner`; on `position`, `--asset` skips a metadata lookup when provided.

| Command | Required flags | Optional | Description |
|---|---|---|---|
| `morpho meta` | `--vault` | | Metadata incl. `isV2`. |
| `morpho position` | `--vault --owner` | `--asset` | Position (`maxWithdrawRaw` always 0 on V2). |
| `morpho gates` | `--vault --owner` | | V2 gate preflight (always true on V1). |
| `morpho plan-deposit` | `--vault --assets --owner` | `--receiver --human` | Gate-checked deposit plan. |
| `morpho plan-redeem` | `--vault --shares --owner` | `--receiver --human` | Redeem plan; reverts on insufficient market liquidity. |

**`boring`**. All commands accept `--teller`, `--queue`, `--from-block` to skip/bound discovery (omitting `--queue` triggers an event scan that can be slow or capped on public RPCs). Plan flags: `--slippage-bps` haircuts the previewed shares to derive `minimumMint` (default 50 = 0.5%); `--discount-bps` is the solver discount on queued withdrawals (default: the queue's minimum for the asset); `--seconds-to-deadline` is the request validity window (default: max(queue minimum, 3 days)).

| Command | Required flags | Optional | Description |
|---|---|---|---|
| `boring discover` | `--vault` | | Derive teller/accountant/queue/authority topology. |
| `boring position` | `--vault --asset --owner` | | Position priced via the accountant rate + both allowances. |
| `boring plan-deposit` | `--vault --asset --amount --owner` | `--slippage-bps --human` | Teller deposit plan with `minimumMint` guard; shares mint to msg.sender. |
| `boring plan-withdraw` | `--vault --asset-out --shares --owner` | `--discount-bps --seconds-to-deadline --human` | Async queue withdrawal plan. |

**`upshift_evm`** (package `@sentora/vaults-upshift-financial`). `--vault` is the TokenizedVault contract, not the receipt token. `--asset` defaults to the vault's reference asset; `--receiver` defaults to `--owner` (on `plan-claim` it is the receiver the redemption was requested for).

| Command | Required flags | Optional | Description |
|---|---|---|---|
| `upshift_evm meta` | `--vault` | | Metadata: LP token, share price, caps, fees, pauses, timelock. |
| `upshift_evm position` | `--vault --owner` | `--asset` | Position + both allowances. |
| `upshift_evm gates` | `--vault --owner` | `--asset` | Whitelist preflight. |
| `upshift_evm plan-deposit` | `--vault --amount --owner` | `--receiver --asset --human` | Deposit plan; caps checked in reference-asset units. |
| `upshift_evm plan-redeem` | `--vault --shares --owner` | `--receiver --instant --human` | Epoch-queue redeem by default; `--instant` burns with a fee. |
| `upshift_evm plan-claim` | `--vault --owner --year --month --day` | `--receiver` | Claim a matured queued redemption (date from the redeem plan/receipt). |
| `upshift_evm epoch` | `--vault` | | Epoch a redemption requested now would land on. |
| `upshift_evm pending-withdrawals` | `--vault --owner` | `--receiver --base-url` | Queued redemptions not paid out yet. `--owner` is the account that called `requestRedeem` (the yields API indexes requests under it). On an RPC without archive state, dates assume the current timelock and `warnings` says so. |

### Plan output format

Every `plan-*` command prints a plan envelope (see the [`@sentora/vaults-plan` README](packages/vaults-plan/README.md#envelope-and-helpers)) stamped with `schemaVersion`, plus `expectedFormatted` twins when `expected` values are present:

```json
{
  "schemaVersion": 1,
  "family": "morpho",
  "action": "deposit",
  "chainId": 1,
  "vault": "0x…",
  "steps": [
    { "kind": "approve", "to": "0x…", "data": "0x…", "value": "0" },
    { "kind": "deposit", "to": "0x…", "data": "0x…", "value": "0" }
  ],
  "expected": { "shares": "9632170049" },
  "expectedFormatted": { "shares": "9632.170049" },
  "blockers": [],
  "warnings": [],
  "context": { }
}
```

Sign and send `steps` in order with any signer (wallet, backend, Safe, agent), waiting for each receipt. **Non-empty `blockers` ⇒ exit code 7 ⇒ do not execute.** See [Plans](#plans) for the full consumer contract.

### Exit codes

| Code | Meaning | Retryable |
|---|---|---|
| 0 | Success | |
| 1 | Unexpected error | usually no |
| 2 | Usage / bad input | no |
| 3 | Not found: a vault the API does not list (API 404), `detect` on an unknown contract, `describe --family` with an unknown family | no |
| 4 | RPC / network failure | yes (no when a sandbox blocks network egress) |
| 5 | Upstream API error | 5xx/429 yes; 401/403 no |
| 6 | Contract revert / wrong contract | no |
| 7 | Plan built but blocked (plan is printed; do not execute) | no |

`npm run cli` prints npm's banner on stdout before the JSON; use `npm run -s cli` or the bin when parsing the output.

## Using via MCP (smart-yield-mcp)

`@sentora/vaults-mcp` ships a stdio MCP server (`smart-yield-mcp`) generated from the CLI command registry at build time: one tool per CLI command (except `describe`), named `<family>_<command>` with dashes as underscores (e.g. `yields_list`, `morpho_plan_deposit`, `upshift_evm_plan_claim`, plus top-level `detect` and `snapshot`). Same validation and error taxonomy as the CLI, zero drift.

**Claude Code** (`.mcp.json`):

```json
{
  "mcpServers": {
    "smart-yield": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@sentora/vaults-mcp"],
      "env": {
        "VAULTS_RPC_URL": "${VAULTS_RPC_URL}",
        "YIELDS_API_KEY": "${YIELDS_API_KEY}"
      }
    }
  }
}
```

Other clients (Codex, Cursor, Gemini CLI, OpenAI Agents SDK, LangChain, CrewAI, Vercel AI SDK) point at the same stdio command.

Behavior:

- **Config is env-only on the server process** (`VAULTS_RPC_URL`, `YIELDS_BASE_URL`, `YIELDS_API_KEY` and their aliases). Endpoints and credentials are never tool arguments, so prompt-injected calls cannot redirect them.
- Tool arguments mirror CLI flags without the `--` prefix; CLI-only flags (`--rpc-url`, `--base-url`, `--output`, `--pretty`, `--timeout`, `--no-multicall`, `--verbose`, `--help`) are excluded.
- Results arrive as `structuredContent` JSON in the same shape as the CLI output (see [Global options](#global-options) for which results carry `formatted` / `expectedFormatted`). MCP requires an object there, so a result that is a list (e.g. `yields_activity`, `yields_positions`) is wrapped as `{ "result": [...] }`; the text content carries the bare list.
- Blocked plans are prefixed `PLAN BLOCKED: do not execute.` in the response text.
- Errors return `isError: true` with the same `{ code, message, retryable, hint? }` body as the CLI.
- All tools are annotated `readOnlyHint: true` (nothing signs or sends) and `openWorldHint: true` (RPC / API calls).

## Testing

```sh
npm run typecheck
npm run test:unit      # fast, no network
npm run test:fork      # requires a local anvil fork, runs serially
```

The fork suite discovers vaults with `yields list` against the production API
(set `YIELDS_BASE_URL`, and `YIELDS_API_KEY` if it needs one, to use another
environment); a failed discovery fails the run instead of skipping it. It
expects anvil at `127.0.0.1:8545` (`FORK_RPC_URL` overrides it), and the forked
chain decides which cases run: Ethereum for morpho/upshift_evm, Ink (57073) for
boring.

```sh
npm run build                                          # the fork suite runs the built CLI
anvil --fork-url $ETH_RPC_URL --chain-id 1             # Ethereum run
anvil --fork-url <ink-rpc-url> --chain-id 57073        # or an Ink run
npm run test:fork
```

`MORPHO_VAULT` and `UPSHIFT_EVM_VAULT` set the vault for the `families` cases
instead of discovering one, and those cases then run on whatever chain the fork
is on. `UPSHIFT_EVM_VAULT` also replaces Sentora USD in the `upshift-financial`
cases, which need an Ethereum fork and a USDC vault.

`npm run verify` reads the main view getters of the deployed Sentora USD vault
on mainnet (`ETH_RPC_URL`, or a public node when unset) and checks they decode
as the SDK expects. It keeps its own ABI copy, so it does not cover every
function in `packages/vaults-upshift-financial/src/abi.ts`, nor the morpho or
boring ABIs.

## License

MIT. See [LICENSE](LICENSE). Every published package ships its own copy.
