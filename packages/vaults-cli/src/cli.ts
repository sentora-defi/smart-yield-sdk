import { parseArgs } from 'node:util';
import { CliError, EXIT_PLAN_BLOCKED, toCliError } from './errors';
import { rootHelp, familyHelp, commandHelp } from './help';
import { shown } from './helpers';
import { GLOBAL_OPTIONS, familyNames, commandsOf, findCommand } from './registry';
import { printResult, printError, type OutputMode } from './output';
import { finalizeResult } from './result';
import { ms, setVerbose, vlog } from './verbose';
import { VERSION } from './version';
import type { CommandDef, Flags } from './types';

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

function didYouMean(input: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = levenshtein(input.toLowerCase(), c.toLowerCase());
    if (d < bestDist) { bestDist = d; best = c; }
  }
  return bestDist <= Math.max(2, Math.floor(input.length / 3)) ? best : undefined;
}

function parseFlags(cmd: CommandDef, args: string[]): Flags {
  const options: Record<string, { type: 'string' | 'boolean' }> = {};
  for (const [name, spec] of Object.entries({ ...GLOBAL_OPTIONS, ...cmd.options })) {
    options[name] = { type: spec.type };
  }
  let values: Flags;
  try {
    values = parseArgs({ args, options, strict: true, allowPositionals: false }).values as Flags;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const known = Object.keys(options).map((n) => `--${n}`);
    if (err.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      const bad = /'(--?[^']+)'/.exec(err.message ?? '')?.[1] ?? '';
      const suggestion = bad ? didYouMean(bad.replace(/^--?/, ''), Object.keys(options)) : undefined;
      throw new CliError('USAGE', `Unknown flag ${bad || '(unparsed)'}.`, {
        hint: suggestion ? `Did you mean --${suggestion}?` : `Known flags: ${known.join(', ')}.`,
      });
    }
    if (err.code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL') {
      throw new CliError('USAGE', err.message ?? 'Unexpected positional argument.', {
        hint: 'All inputs are flags — see --help for this command.',
      });
    }
    throw new CliError('USAGE', err.message ?? 'Failed to parse arguments.');
  }
  const missing = Object.entries(cmd.options)
    .filter(([name, spec]) => spec.required && values[name] === undefined)
    .map(([name, spec]) => `--${name} ${spec.placeholder ?? '<value>'}`);
  if (missing.length) {
    throw new CliError('USAGE', `Missing required flag(s): ${missing.join(', ')}.`, {
      hint: `Run 'smart-yield ${cmd.family ? `${cmd.family} ` : ''}${cmd.name} --help' for usage and examples.`,
    });
  }
  return values;
}

function outputMode(flags: Flags): OutputMode {
  const v = flags.output;
  if (v === undefined || v === 'json') return 'json';
  if (v === 'text') return 'text';
  throw new CliError('USAGE', `--output must be 'json' or 'text', got '${shown(String(v))}'.`);
}

async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    process.stdout.write(rootHelp() + '\n');
    return argv.length === 0 ? 2 : 0;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write(`smart-yield ${VERSION}\n`);
    return 0;
  }

  const first = argv[0];
  let cmd: CommandDef | undefined;
  let flagArgs: string[];

  const topLevel = findCommand('', first);
  if (topLevel) {
    cmd = topLevel;
    flagArgs = argv.slice(1);
  } else {
    if (!familyNames().includes(first)) {
      const suggestion = didYouMean(first, [...familyNames(), 'describe', 'detect']);
      throw new CliError('USAGE', `Unknown family '${first}'.`, {
        hint: `${suggestion ? `Did you mean '${suggestion}'? ` : ''}Families: ${familyNames().join(', ')}. Run 'smart-yield --help'.`,
      });
    }
    const verb = argv[1];
    if (verb === undefined || verb === '--help' || verb === '-h') {
      if (verb === undefined) {
        throw new CliError('USAGE', `Missing command for family '${first}'.`, {
          hint: `Commands: ${commandsOf(first).map((c) => c.name).join(', ')}. Run 'smart-yield ${first} --help'.`,
        });
      }
      process.stdout.write(familyHelp(first) + '\n');
      return 0;
    }
    cmd = findCommand(first, verb);
    if (!cmd) {
      const names = commandsOf(first).map((c) => c.name);
      const suggestion = didYouMean(verb, names);
      throw new CliError('USAGE', `Unknown command '${verb}' for family '${first}'.`, {
        hint: `${suggestion ? `Did you mean '${suggestion}'? ` : ''}Commands: ${names.join(', ')}.`,
      });
    }
    flagArgs = argv.slice(2);
  }

  if (!cmd) throw new CliError('UNEXPECTED', 'Command resolution failed.');
  if (flagArgs.includes('--help') || flagArgs.includes('-h')) {
    process.stdout.write(commandHelp(cmd) + '\n');
    return 0;
  }

  const flags = parseFlags(cmd, flagArgs);
  setVerbose(flags.verbose === true);
  const mode = outputMode(flags);
  const started = performance.now();
  const { payload, blocked } = finalizeResult(await cmd.run(flags));
  printResult(payload, mode, flags.pretty === true);
  vlog(`${cmd.family ? `${cmd.family} ` : ''}${cmd.name}: ${blocked ? `BLOCKED (exit ${EXIT_PLAN_BLOCKED})` : 'ok'} in ${ms(started)}`);
  return blocked ? EXIT_PLAN_BLOCKED : 0;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e) => {
    const err = toCliError(e);
    // best-effort output mode: honor --output text if it made it onto argv
    const mode: OutputMode = process.argv.includes('text') && process.argv.includes('--output') ? 'text' : 'json';
    printError(err, mode);
    process.exitCode = err.exitCode;
  },
);
