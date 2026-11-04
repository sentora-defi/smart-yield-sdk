import type { CliError } from './errors';

export type OutputMode = 'json' | 'text';

export function toJson(value: unknown, pretty: boolean): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), pretty ? 2 : undefined);
}

const BACKSLASH = String.fromCharCode(92);

/**
 * Text mode is line-oriented and agents parse it: a control char (newline,
 * ANSI escape) inside an untrusted value (on-chain symbol, API field, revert
 * reason) could forge extra `path=value` lines. JSON mode gets the equivalent
 * from JSON.stringify.
 */
export function escapeControl(s: string): string {
  let out = '';
  for (const c of s) {
    const n = c.codePointAt(0) ?? 0;
    if (n === 10) out += BACKSLASH + 'n';
    else if (n === 13) out += BACKSLASH + 'r';
    else if (n === 9) out += BACKSLASH + 't';
    else if (n < 32 || n === 127) out += BACKSLASH + 'x' + n.toString(16).padStart(2, '0');
    else out += c;
  }
  return out;
}

/** text mode: one `path=value` line per leaf — greppable, stable ordering */
function flatten(value: unknown, prefix: string): [string, string][] {
  if (value === null || value === undefined || typeof value !== 'object') {
    return [[prefix || 'value', String(value)]];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [[prefix, '[]']];
    return value.flatMap((v, i) => flatten(v, prefix ? `${prefix}[${i}]` : `[${i}]`));
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return [[prefix, '{}']];
  return entries.flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k));
}

export function printResult(value: unknown, mode: OutputMode, pretty: boolean): void {
  if (mode === 'text') {
    for (const [path, v] of flatten(value, '')) process.stdout.write(`${escapeControl(path)}=${escapeControl(v)}\n`);
    return;
  }
  process.stdout.write(toJson(value, pretty) + '\n');
}

export function printError(err: CliError, mode: OutputMode): void {
  if (mode === 'text') {
    process.stderr.write(`Error (${err.code}): ${escapeControl(err.message)}\n`);
    if (err.hint) process.stderr.write(`Hint: ${escapeControl(err.hint)}\n`);
    return;
  }
  const body: Record<string, unknown> = { code: err.code, message: err.message, retryable: err.retryable };
  if (err.hint) body.hint = err.hint;
  process.stderr.write(JSON.stringify({ error: body }) + '\n');
}
