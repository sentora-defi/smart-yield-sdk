# Sentora SmartYield — agent instructions

Monorepo for Sentora SmartYield: per-vault-family SDK packages and the
`smart-yield` CLI (read-only vault state + UNSIGNED transaction plans).

## Layout

- `packages/vaults-cli` — the `smart-yield` CLI. Only argv parsing, output
  shaping, and exit codes live here; all vault logic is in the family SDKs.
- `packages/vaults-{morpho,boring,upshift-financial}` — family SDKs,
  each layered as `encode.ts` (pure calldata) / `plan.ts` (RPC preflight) /
  `core.ts` (execute wrappers for React hooks).
- `packages/vaults-mcp` — MCP stdio server (`smart-yield-mcp`) generated from
  the CLI command registry; the CLI package itself stays dependency-free.
- `packages/vaults-plan` — the plan envelope serialization convention
  (steps/expected/blockers/warnings, bigints as decimal strings). A payload
  convention, NOT a unified vault interface. Also holds the client types the
  families take (`ReadClient`, `WriteClient`, `SignerClient`),
  `sendSimulated`, the ABI-agnostic write helper the `core` wrappers share, and
  `approveNeedsReset`, the one shared RPC preflight (ERC-20 residual-allowance
  simulation).
- `packages/yields-client` — Sentora yields API client.
- `test/unit` (fast, no network) and `test/fork` (needs a local anvil fork).

## Commands

```sh
npm run build          # build every package: CLI/MCP bundles + library dist (JS + .d.ts)
npm run typecheck
npm run test:unit      # fast, no network
npm run test:fork      # local anvil fork required, runs serially
node packages/vaults-cli/dist/cli.mjs --help
```

## Rules

- Any CLI, script bin, or dev tool built or modified in this repo must be
  non-interactive and deterministic, with JSON-capable, token-efficient
  output, actionable errors and dry-run on mutations. Keep the security rules that
  `test/unit/security.test.mjs` enforces (among them: API key from env only and
  sent only to the configured origins, no redirects while a key is set, HTTPS
  off loopback, RPC URLs redacted in output, upstream text escaped, inputs
  validated before any request) and extend it when adding surface that touches
  secrets, external data, or plan-shaping inputs.
- Plans are handed to external signers as-is: never add an exec/sign/broadcast
  path to the CLI.
- The API key is env-only, never a flag: `YIELDS_API_KEY` (or `SENTORA_API_KEY`).
  RPC endpoint via `VAULTS_RPC_URL` (or `SENTORA_RPC_URL` / `ETH_RPC_URL`) or
  `--rpc-url`, API base via `YIELDS_BASE_URL` (or `SENTORA_API_URL`) or
  `--base-url`. The API key is sent only to the default or an env-configured
  origin; a `--base-url` pointing anywhere else is refused while a key is set.

## The CLI in one call

`smart-yield describe` dumps the full command surface (families, flags,
examples, exit codes) as JSON. Exit codes: 0 ok · 1 unexpected · 2 usage ·
3 not found · 4 rpc/network (retryable) · 5 upstream api · 6 contract revert ·
7 plan blocked (plan printed — do not execute).
