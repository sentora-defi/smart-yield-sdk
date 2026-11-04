import { GLOBAL_OPTIONS, FAMILY_SUMMARIES, commandsOf } from './registry';
import { VERSION } from './version';
import type { CommandDef, OptSpec } from './types';

function flagLines(options: Record<string, OptSpec>): string[] {
  const entries = Object.entries(options);
  const rendered = entries.map(([name, o]) => {
    const left = `--${name}${o.type === 'boolean' ? '' : ` ${o.placeholder ?? '<value>'}`}`;
    return [left, `${o.required ? '(required) ' : ''}${o.description}`] as const;
  });
  const width = Math.max(0, ...rendered.map(([l]) => l.length));
  return rendered.map(([l, r]) => `  ${l.padEnd(width)}  ${r}`);
}

export function rootHelp(): string {
  const width = Math.max(...Object.keys(FAMILY_SUMMARIES).map((n) => n.length));
  const families = Object.entries(FAMILY_SUMMARIES).map(([name, summary]) => {
    const cmds = commandsOf(name).map((c) => c.name).join(' | ');
    return `  ${name.padEnd(width)} ${summary}\n  ${' '.repeat(width)} commands: ${cmds}`;
  });
  return [
    `smart-yield ${VERSION} — read-only CLI over the Sentora vault packages`,
    '',
    'Every command is a query: reads vault state or builds UNSIGNED transaction plans.',
    'Nothing here signs or sends. A plan with non-empty `blockers` must not be executed.',
    'Blockers that compare token amounts carry base-unit `available` / `required` (and `decimals` when known).',
    '',
    'Usage:',
    '  smart-yield <family> <command> [flags]',
    '  smart-yield describe [--family <f>]      machine-readable command surface (JSON)',
    '  smart-yield detect --vault <address>     probe a vault and report its family',
    '  smart-yield snapshot --vault <a>[,<b>…]  one-call preflight: family + meta (+ gates/position with --owner)',
    '  smart-yield <family> --help              list commands of one family',
    '  smart-yield <family> <command> --help    flags and examples of one command',
    '',
    'Families:',
    ...families,
    '',
    'Global flags:',
    ...flagLines(GLOBAL_OPTIONS),
    '',
    'Environment: VAULTS_RPC_URL (or SENTORA_RPC_URL / ETH_RPC_URL), YIELDS_BASE_URL (or SENTORA_API_URL; defaults to the production API), YIELDS_API_KEY (or SENTORA_API_KEY)',
    'Output: result JSON on stdout; errors as {"error":{...}} on stderr. On-chain amounts are base units unless --human; yields API amounts are token units or USD, except fields ending in Raw (base units).',
    'Exit codes: 0 ok · 1 unexpected · 2 usage · 3 not found · 4 rpc/network (retryable) · 5 upstream api · 6 contract revert · 7 plan blocked (do not execute)',
    '',
    'Example (discover a vault via the API, then read it on-chain):',
    '  smart-yield yields list --chain 1 --fields "name,family,contracts"',
    '  smart-yield detect --vault 0xVAULT --rpc-url https://ethereum-rpc.publicnode.com',
  ].join('\n');
}

export function familyHelp(family: string): string {
  const cmds = commandsOf(family);
  const width = Math.max(...cmds.map((c) => c.name.length));
  return [
    `smart-yield ${family} — ${FAMILY_SUMMARIES[family]}`,
    '',
    `Usage: smart-yield ${family} <command> [flags]`,
    '',
    'Commands:',
    ...cmds.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    '',
    `Run 'smart-yield ${family} <command> --help' for flags and examples.`,
  ].join('\n');
}

export function commandHelp(cmd: CommandDef): string {
  const required = Object.entries(cmd.options).filter(([, o]) => o.required);
  const optional = Object.entries(cmd.options).filter(([, o]) => !o.required);
  const usage = [
    `smart-yield ${cmd.family ? `${cmd.family} ` : ''}${cmd.name}`,
    ...required.map(([n, o]) => `--${n} ${o.placeholder ?? '<value>'}`),
    optional.length ? '[flags]' : '',
  ].filter(Boolean).join(' ');
  return [
    `Usage: ${usage}`,
    '',
    cmd.summary,
    '',
    'Flags:',
    ...flagLines(cmd.options),
    '',
    'Global flags:',
    ...flagLines(GLOBAL_OPTIONS),
    '',
    'Examples:',
    ...cmd.examples.map((e) => `  ${e}`),
  ].join('\n');
}
