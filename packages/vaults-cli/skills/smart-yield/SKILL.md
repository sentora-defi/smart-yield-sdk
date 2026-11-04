---
name: smart-yield
description: >-
  Discover Sentora/DeFi vaults, evaluate yield (APY, TVL, risk), read wallet
  positions, and build UNSIGNED deposit/withdraw/redeem transaction plans as
  JSON via the smart-yield CLI. Use when the user asks about vaults, yields,
  APY, deposits, withdrawals, redemptions, or portfolio positions on Sentora
  SmartYield. Not for signing, sending, or broadcasting transactions — plans
  are handed to an external signer.
allowed-tools: Bash(smart-yield *), Bash(npx -p @sentora/vaults-cli smart-yield *)
---

# smart-yield — read-only vault CLI

Every command is a query: it reads vault state or builds an UNSIGNED
transaction plan. Nothing here signs or sends.

## Learn the surface

```sh
smart-yield describe                     # full command surface as JSON: families, flags, examples, exit codes
smart-yield describe --family boring     # one family only
```

Grammar: `smart-yield <family> <command> [flags]`. Families: `morpho`,
`boring`, `upshift_evm` (on-chain via RPC) and `yields` (Sentora yields API).
Top-level: `describe`, `detect --vault 0x…`, `snapshot --vault "0xA[,0xB…]"`.

## Typical workflow

```sh
# 1. discover vaults (filter + project fields to stay token-lean)
smart-yield yields list --chain eip155:1 --fields "name,family,contracts"

# 2. evaluate performance (summary stats, never raw series)
smart-yield yields analytics --chain-id eip155:1 --address 0xVAULT --days 30 --summary

# 3. preflight candidates in ONE call: family + meta (+ gates/position with --owner)
smart-yield snapshot --vault "0xA,0xB" --owner 0xYOU --rpc-url $RPC

# 4. build the unsigned plan
smart-yield upshift_evm plan-deposit --vault 0xA --amount 100.5 --human --owner 0xYOU --rpc-url $RPC
```

## Plan safety — non-negotiable

- A plan's `steps` are unsigned `{to, data, value}` transactions for an
  external signer, executed strictly in order, waiting for each receipt.
- Non-empty `blockers` ⇒ exit code 7 ⇒ the plan MUST NOT be executed, even
  though it is printed.
- Blockers that compare token amounts (balances, caps, per-tx limits,
  minimums) also carry `available` / `required` (base-unit strings) and, when
  known, `decimals` — read those instead of parsing `message`. Upshift caps and
  per-tx limits are in reference-asset units; its `INSUFFICIENT_BALANCE` is in
  `--asset` units and has no `decimals` when that is not the reference asset.
- Never fabricate or edit step calldata; regenerate the plan instead.

## Output and exit codes

- stdout is data: compact JSON, bigints as decimal strings (`--pretty`,
  `--output text` for `path=value` lines). stderr carries errors as
  `{"error":{"code","message","retryable","hint"}}` — follow the `hint`, and
  retry only when `retryable` is true.
- Exit codes: 0 ok · 1 unexpected · 2 usage · 3 not found · 4 rpc/network
  (retryable) · 5 upstream api · 6 contract revert · 7 plan blocked.
- Amounts are base units by default; `--human` accepts decimals (`100.5`) and
  scales by on-chain token decimals. Plans include `expectedFormatted` when
  `expected` has values, and `morpho meta` / `upshift_evm meta` include
  `formatted`. In `yields` output the typed amounts (e.g. `analytics.tvl`,
  `liveBalanceInKind`) are already token units or USD, except fields ending in
  `Raw` (base units); the vendor `data` of `yields risk` is passed through
  untyped. Other on-chain outputs are base units.
- Pagination: `--limit/--offset/--fields` on list commands; responses report
  `total/truncated/remaining` — truncation is never silent.

## Configuration (env-only secrets)

- RPC endpoint: `--rpc-url` flag, else `VAULTS_RPC_URL` / `SENTORA_RPC_URL` /
  `ETH_RPC_URL`.
- Sentora yields API: `YIELDS_BASE_URL` (or `SENTORA_API_URL`; defaults to production)
  and `YIELDS_API_KEY` (or `SENTORA_API_KEY`). The API key cannot be passed as
  a flag and is only sent to the default or env-configured origin.
- `--timeout <ms>` bounds every network call (default 30000).

## Gotchas

- Pipes mask exit codes (`$?` is the last pipeline element) — branch on
  `${PIPESTATUS[0]}` or run unpiped.
- Network failures inside an agent sandbox (e.g. Codex with egress disabled)
  return exit 4 with a hint naming the sandbox fix — read the hint before
  retrying.
