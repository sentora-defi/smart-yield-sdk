/**
 * MCP stdio server over the smart-yield command registry. Tools are GENERATED
 * from the CLI's CommandDef registry (bundled at build time via relative
 * imports — @sentora/vaults-cli publishes no library entry point), so the two
 * surfaces cannot drift: same validation, same error taxonomy, same payloads.
 *
 * stdio discipline: stdout carries exclusively JSON-RPC (the transport owns
 * it); everything else goes to stderr.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CliError, toCliError } from '../../vaults-cli/src/errors';
import { toJson } from '../../vaults-cli/src/output';
import { registry, GLOBAL_OPTIONS } from '../../vaults-cli/src/registry';
import { finalizeResult } from '../../vaults-cli/src/result';
import { VERSION } from '../../vaults-cli/src/version';
import type { CommandDef, Flags } from '../../vaults-cli/src/types';

/**
 * Config/transport flags stay OUT of tool inputs: endpoints come from env only
 * (VAULTS_RPC_URL, YIELDS_BASE_URL, …), so a prompt-injected tool call can
 * never redirect credentials or reshape output. `help` and output shaping are
 * meaningless over MCP.
 */
const EXCLUDED_FLAGS = new Set([...Object.keys(GLOBAL_OPTIONS), 'base-url']);

const mcpCommands = registry.filter((cmd) => cmd.name !== 'describe');

function toolName(cmd: CommandDef): string {
  return (cmd.family ? `${cmd.family}_${cmd.name}` : cmd.name).replace(/-/g, '_');
}

function inputSchema(cmd: CommandDef): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, spec] of Object.entries(cmd.options)) {
    if (EXCLUDED_FLAGS.has(name)) continue;
    properties[name] = { type: spec.type, description: spec.description };
    if (spec.required) required.push(name);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

const byName = new Map(mcpCommands.map((cmd) => [toolName(cmd), cmd]));

function toFlags(cmd: CommandDef, args: Record<string, unknown>): Flags {
  const flags: Flags = {};
  for (const [key, value] of Object.entries(args)) {
    const spec = Object.hasOwn(cmd.options, key) ? cmd.options[key] : undefined;
    if (!spec || EXCLUDED_FLAGS.has(key)) {
      const known = Object.keys(cmd.options).filter((n) => !EXCLUDED_FLAGS.has(n));
      throw new CliError('USAGE', `Unknown argument '${key}'.`, { hint: `Arguments: ${known.join(', ') || '(none)'}.` });
    }
    if (typeof value !== spec.type) {
      throw new CliError('USAGE', `Argument '${key}' must be a ${spec.type}, got ${typeof value}.`, {
        hint: spec.type === 'string' ? 'Amounts, ids, and addresses travel as strings (bigint-safe).' : undefined,
      });
    }
    flags[key] = value as string | boolean;
  }
  return flags;
}

const server = new Server(
  { name: 'smart-yield', title: 'Sentora smart-yield vaults', version: VERSION },
  {
    capabilities: { tools: {} },
    instructions:
      'Read-only Sentora vault tools: discovery, yield analytics, positions, and UNSIGNED transaction plans. ' +
      'Nothing signs or sends. A plan with non-empty `blockers` MUST NOT be executed. ' +
      'Blockers that compare token amounts carry base-unit `available` / `required` (and `decimals` when known); read those, not `message`. ' +
      'Upshift caps and per-tx limits are in reference-asset units, not deposit-asset units. ' +
      'Endpoints/credentials come from server env only: VAULTS_RPC_URL (or SENTORA_RPC_URL/ETH_RPC_URL), ' +
      'YIELDS_BASE_URL (or SENTORA_API_URL), YIELDS_API_KEY (or SENTORA_API_KEY). ' +
      'Tool schemas from tools/list are authoritative; on-chain amounts are base units unless `human` is set; yields API amounts are token units or USD, except fields ending in `Raw` (base units).',
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: mcpCommands.map((cmd) => ({
    name: toolName(cmd),
    title: cmd.family ? `${cmd.family}: ${cmd.name}` : cmd.name,
    description: cmd.summary,
    inputSchema: inputSchema(cmd),
    annotations: { title: cmd.family ? `${cmd.family}: ${cmd.name}` : cmd.name, readOnlyHint: true, openWorldHint: true },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const cmd = byName.get(req.params.name);
    if (!cmd) {
      throw new CliError('USAGE', `Unknown tool '${req.params.name}'.`, { hint: `Tools: ${[...byName.keys()].join(', ')}.` });
    }
    const { payload, blocked } = finalizeResult(await cmd.run(toFlags(cmd, req.params.arguments ?? {})));
    const text = toJson(payload, false);
    const parsed = JSON.parse(text) as unknown;
    return {
      content: [{ type: 'text', text: blocked ? `PLAN BLOCKED: do not execute. ${text}` : text }],
      structuredContent: (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : { result: parsed }) as Record<string, unknown>,
    };
  } catch (e) {
    const err = toCliError(e);
    const body: Record<string, unknown> = { code: err.code, message: err.message, retryable: err.retryable };
    if (err.hint) body.hint = err.hint;
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: body }) }] };
  }
});

await server.connect(new StdioServerTransport());
