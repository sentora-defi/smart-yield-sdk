# @sentora/vaults-mcp — MCP server for Sentora vaults

MCP stdio server exposing the [smart-yield](https://www.npmjs.com/package/@sentora/vaults-cli) command
surface as tools: vault discovery, yield analytics, positions, and UNSIGNED
transaction plans. Tools are generated from the CLI's command registry at
build time — same validation, same error taxonomy, zero drift.

Use this for frameworks that consume tools rather than binaries (LangChain,
CrewAI, OpenAI Agents SDK, Vercel AI SDK, Microsoft Agent Framework, IDE MCP
configs). Shell-capable coding agents are better served by the CLI directly.

## Tools

One tool per CLI command (except the CLI-only `describe`), named
`<family>_<command>` with dashes as underscores: `detect`, `snapshot`,
`yields_list`, `yields_get`, `morpho_plan_deposit`,
`upshift_evm_plan_redeem`, … Arguments are the CLI flags (same names,
amounts as strings). Every tool is annotated `readOnlyHint: true` — nothing
signs or sends.

- Results arrive as `structuredContent` (JSON, bigints as decimal strings). A result that is a list is wrapped as `{ "result": [...] }`, since MCP requires an object there; the text content carries the bare list.
- A plan with non-empty `blockers` is prefixed `PLAN BLOCKED: do not execute.`
- Errors carry the CLI taxonomy: `{"error":{code, message, retryable, hint}}`.

## Configuration (env only, by design)

Config and credentials are never tool arguments — set them on the server
process: `VAULTS_RPC_URL` (or `SENTORA_RPC_URL` / `ETH_RPC_URL`),
`YIELDS_BASE_URL` (or `SENTORA_API_URL`; defaults to production),
`YIELDS_API_KEY` (or `SENTORA_API_KEY`).

## Client setup

**Claude Code** (`.mcp.json` at repo root):

```json
{
  "mcpServers": {
    "smart-yield": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@sentora/vaults-mcp"],
      "env": { "VAULTS_RPC_URL": "${VAULTS_RPC_URL}", "YIELDS_API_KEY": "${YIELDS_API_KEY}" }
    }
  }
}
```

**Codex**: `codex mcp add smart-yield -- npx -y @sentora/vaults-mcp`

**Cursor** (`.cursor/mcp.json`) and **Gemini CLI** (`.gemini/settings.json`,
under `mcpServers`): same `command`/`args`/`env` shape as Claude Code.

**OpenAI Agents SDK**:

```python
from agents.mcp import MCPServerStdio
server = MCPServerStdio(params={"command": "npx", "args": ["-y", "@sentora/vaults-mcp"]})
```

**LangChain** (`langchain-mcp-adapters`), **CrewAI** (`MCPServerAdapter`),
**Vercel AI SDK** (`@ai-sdk/mcp` stdio transport): point at the same command.
