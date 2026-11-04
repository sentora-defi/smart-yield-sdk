import { morphoCommands } from './families/morpho';
import { upshiftFinancialCommands } from './families/upshift-financial';
import { boringCommands } from './families/boring';
import { yieldsCommands } from './families/yields';
import { detectCommand } from './families/detect';
import { snapshotCommand } from './families/snapshot';
import { CliError, EXIT_CODES, EXIT_PLAN_BLOCKED } from './errors';
import { SCHEMA_VERSION, VERSION } from './version';
import type { CommandDef, OptSpec } from './types';

export const GLOBAL_OPTIONS: Record<string, OptSpec> = {
  'rpc-url': { type: 'string', placeholder: '<url>', description: 'JSON-RPC endpoint. Precedence: flag, then VAULTS_RPC_URL, SENTORA_RPC_URL, ETH_RPC_URL.' },
  output: { type: 'string', placeholder: 'json|text', description: "Output format: 'json' (default, compact, bigints as decimal strings) or 'text' (one path=value per line)." },
  pretty: { type: 'boolean', description: 'Pretty-print JSON output (default is compact single-line).' },
  timeout: { type: 'string', placeholder: '<ms>', description: 'Per-request network timeout in milliseconds (default 30000; 0 = no limit).' },
  'no-multicall': { type: 'boolean', description: 'Disable Multicall3 read batching (for chains without the canonical Multicall3 deployment).' },
  verbose: { type: 'boolean', description: 'Emit diagnostics to stderr (endpoint resolution, per-request timing, amount conversions). stdout stays clean JSON.' },
  help: { type: 'boolean', description: 'Show help.' },
};

export const FAMILY_SUMMARIES: Record<string, string> = {
  morpho: 'Morpho vaults, V1 MetaMorpho + V2 (gates)',
  upshift_evm: 'Upshift Financial TokenizedVaults (multi-asset deposits, epoch-queued or instant redemption)',
  boring: 'Boring/Veda vaults (teller deposits, async solver-queue withdrawals)',
  yields: 'Sentora yields API (vault discovery, analytics, risk, user positions)',
};

const describeCommand: CommandDef = {
  family: '',
  name: 'describe',
  summary: 'Dump the command surface (flags, requirements, examples, exit codes) as JSON. --family trims to one family.',
  options: {
    family: { type: 'string', placeholder: '<family>', description: 'Only describe commands of this family (morpho, boring, upshift_evm, yields).' },
  },
  examples: ['smart-yield describe', 'smart-yield describe --family upshift_evm'],
  run: async (flags) => ({
    name: 'smart-yield',
    version: VERSION,
    schemaVersion: SCHEMA_VERSION,
    grammar: 'smart-yield <family> <command> [flags]',
    readOnly: 'Every command is a query — nothing signs or sends transactions. plan-* commands return unsigned payloads; a plan with non-empty blockers exits with code 7 and must not be executed.',
    environment: {
      VAULTS_RPC_URL: 'RPC endpoint when --rpc-url is not passed (SENTORA_RPC_URL / ETH_RPC_URL also honored).',
      YIELDS_BASE_URL: 'Base URL for yields commands (SENTORA_API_URL also honored). Defaults to the production API when unset.',
      YIELDS_API_KEY: 'API key for yields commands (SENTORA_API_KEY also honored).',
    },
    exitCodes: {
      0: 'success',
      [EXIT_CODES.UNEXPECTED]: 'unexpected error',
      [EXIT_CODES.USAGE]: 'bad input / usage',
      [EXIT_CODES.NOT_FOUND]: 'not found',
      [EXIT_CODES.RPC_ERROR]: 'rpc/network failure (retryable)',
      [EXIT_CODES.UPSTREAM_API]: 'upstream API error',
      [EXIT_CODES.CONTRACT_ERROR]: 'contract revert / wrong contract (not retryable)',
      [EXIT_PLAN_BLOCKED]: 'plan built and printed but has blockers — do not execute',
    },
    globalFlags: GLOBAL_OPTIONS,
    families: FAMILY_SUMMARIES,
    commands: registry
      .filter((c) => c.name !== 'describe')
      .filter((c) => {
        const want = typeof flags.family === 'string' ? flags.family : undefined;
        if (want === undefined) return true;
        if (!Object.hasOwn(FAMILY_SUMMARIES, want)) {
          throw new CliError('NOT_FOUND', `Unknown family '${want}'.`, { hint: `Families: ${Object.keys(FAMILY_SUMMARIES).join(', ')}.` });
        }
        return c.family === want;
      })
      .map((c) => ({
        command: c.family ? `${c.family} ${c.name}` : c.name,
        summary: c.summary,
        flags: Object.fromEntries(
          Object.entries(c.options).map(([n, o]) => [
            `--${n}`,
            { required: o.required ?? false, value: o.type === 'boolean' ? null : (o.placeholder ?? '<value>'), description: o.description },
          ]),
        ),
        examples: c.examples,
      })),
  }),
};

export const registry: CommandDef[] = [
  describeCommand,
  detectCommand,
  snapshotCommand,
  ...morphoCommands,
  ...upshiftFinancialCommands,
  ...boringCommands,
  ...yieldsCommands,
];

export function familyNames(): string[] {
  return Object.keys(FAMILY_SUMMARIES);
}

export function commandsOf(family: string): CommandDef[] {
  return registry.filter((c) => c.family === family);
}

export function findCommand(family: string, name: string): CommandDef | undefined {
  return registry.find((c) => c.family === family && c.name === name);
}
