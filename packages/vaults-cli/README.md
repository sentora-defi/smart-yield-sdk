# smart-yield — the agent CLI for Sentora vaults

Discover vaults, evaluate yield, and build unsigned transaction plans from the
command line. Designed for AI agents and automation first: JSON output,
branchable exit codes, self-describing commands. Every command is a query —
nothing here signs or sends.

```sh
npm install -g @sentora/vaults-cli    # or run once: npx -p @sentora/vaults-cli smart-yield --help
smart-yield --help
```

## A yield evaluation in four commands

```sh
# 1. What vaults exist? (filter by chain, family, curator; project fields)
smart-yield yields list --chain eip155:1 --fields "name,family,contracts"

# 2. How do candidates perform? (summary stats, not raw series)
smart-yield yields analytics --chain-id eip155:1 --address 0xVAULT --days 30 --summary

# 3. Preflight several vaults in ONE call: family + meta + gates + your position
smart-yield snapshot --vault "0xA,0xB,0xC" --owner 0xYOU --rpc-url $RPC

# 4. Build the deposit — unsigned steps, previewed outcome, named blockers
smart-yield upshift_evm plan-deposit --vault 0xA --amount 10000 --human --owner 0xYOU --rpc-url $RPC
```

Plans return ordered unsigned `{to, data, value}` steps for any signer, with
`expected` outcomes (plus `expectedFormatted` human-decimal twins) and
`blockers`. **Non-empty blockers ⇒ exit code 7 ⇒ do not execute.**

## Commands

```
smart-yield <family> <command> [flags]
```

| scope | commands |
|---|---|
| top-level | `describe [--family <f>]` · `detect --vault 0x…` · `snapshot --vault "0xA[,0xB…]" [--owner] [--base-url]` |
| `yields` (API) | `list` · `get` · `analytics` · `risk` · `main-insights` · `balance` · `activity` · `positions` · `blockchains` |
| `upshift_evm` | `meta` · `position` · `gates` · `plan-deposit` · `plan-redeem [--instant]` · `plan-claim` · `epoch` · `pending-withdrawals` |
| `boring` (Veda) | `discover` · `position` · `plan-deposit` · `plan-withdraw` |
| `morpho` | `meta` · `position` · `gates` · `plan-deposit` · `plan-redeem` |

`describe` dumps the full surface as JSON (flags, requirements, examples, exit
codes) — point an agent at it once and it knows the whole tool. `detect`
classifies any address on-chain and refuses to guess unknown architectures
(exit 3). Typos at any level get "did you mean" suggestions.

## Output contract

- **stdout is data**: compact JSON, bigints as decimal strings; `--pretty` for
  humans, `--output text` for one `path=value` per line (grep-friendly).
- **stderr is everything else**: errors as
  `{"error":{"code","message","retryable","hint"}}`; `--verbose` diagnostics
  prefixed `# ` (endpoint provenance, per-RPC timing, unit conversions).
- **Exit codes**: `0` ok · `1` unexpected · `2` usage · `3` not found ·
  `4` rpc/network (retryable) · `5` upstream api · `6` contract revert ·
  `7` plan blocked (plan still printed).
- Plan results and `describe` carry `schemaVersion` — bumped on any breaking
  shape change; pin automations to it.
- Amounts are base units by default (`1000000` = 1 USDC); `--human` accepts
  decimals (`100.5`) and scales by on-chain token decimals. Plans add
  `expectedFormatted` when `expected` has values, and `morpho meta` /
  `upshift_evm meta` add `formatted`. `yields` amounts come from the API and
  are already token units or USD, except fields ending in `Raw`. Other
  on-chain outputs carry only base units.

## Performance

Reads batch through Multicall3, so a command makes a few RPC round trips
instead of one per contract call (`--no-multicall` opts out on chains without
the canonical deployment). `--timeout <ms>` bounds every network call (default
30s, `0` = no limit). `yields analytics --summary` / `--last N` and `list --fields/--limit/
--offset` keep responses small; truncation is always announced.

## Configuration

| what | flag | env (flags win) |
|---|---|---|
| RPC endpoint | `--rpc-url` | `VAULTS_RPC_URL`, `SENTORA_RPC_URL`, `ETH_RPC_URL` |
| yields API base | `--base-url` | `YIELDS_BASE_URL`, `SENTORA_API_URL` (default: production) |
| yields API key | — (env only, never a flag) | `YIELDS_API_KEY`, `SENTORA_API_KEY` |

Shell note: pipes mask exit codes (`$?` is the last pipeline element) — branch
on `${PIPESTATUS[0]}` or run unpiped.

## Using from agent frameworks

Shell-capable coding agents use this CLI directly (below). Frameworks that
consume tools instead of binaries (LangChain, CrewAI, OpenAI Agents SDK, IDE
MCP configs, …) use [`@sentora/vaults-mcp`](https://www.npmjs.com/package/@sentora/vaults-mcp) — an MCP
stdio server generated from this CLI's command registry. This package itself
stays dependency-free either way.

The package ships an [Agent Skill](skills/smart-yield/SKILL.md) (open SKILL.md
standard — Claude Code, Codex, Copilot CLI). Install it by copying the folder:

```sh
# Claude Code (project)          # Codex
.claude/skills/smart-yield/      .agents/skills/smart-yield/
```

Paste into the consuming repo's `AGENTS.md` (Codex, Cursor, Copilot, Gemini
CLI, …) or `CLAUDE.md`:

```markdown
## smart-yield CLI
Read-only Sentora vault CLI: discovery, yield analytics, positions, and
UNSIGNED tx plans as JSON. Run `smart-yield describe` for the full surface.
Exit codes: 0 ok · 1 unexpected · 2 usage · 3 not found · 4 rpc/network (retryable) ·
5 upstream api · 6 contract revert · 7 plan blocked (NEVER execute a blocked
plan). Auth: YIELDS_API_KEY env (never a flag). RPC: VAULTS_RPC_URL env or
--rpc-url. Plans are unsigned — hand them to the signer; never sign a plan
with non-empty blockers.
```

Permission allowlists (the CLI is read-only, safe to pre-approve):

- Claude Code `.claude/settings.json`:
  `{"permissions": {"allow": ["Bash(smart-yield *)", "Bash(npx -p @sentora/vaults-cli smart-yield *)"]}}`
- Gemini CLI `settings.json`:
  `{"tools": {"core": ["run_shell_command(smart-yield)"]}}`
- Codex: network egress is off in the default sandbox — set
  `[sandbox_workspace_write] network_access = true` in `~/.codex/config.toml`
  (error hints say this too). In Codex cloud, install in the setup script and
  allowlist the API/RPC domains with POST permitted.

---

Architecture in one line: this package is argv parsing, JSON serialization,
and exit codes — all vault logic lives in the family SDKs
(`@sentora/vaults-{upshift-financial,boring,morpho}`), plans in
`@sentora/vaults-plan`, API access in `@sentora/yields-client`.
