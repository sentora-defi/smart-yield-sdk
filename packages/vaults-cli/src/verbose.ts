/**
 * --verbose diagnostics. Always stderr, never stdout — stdout is the data
 * contract and must stay parseable regardless of verbosity.
 */
let enabled = false;

export function setVerbose(on: boolean): void {
  enabled = on;
}

export function isVerbose(): boolean {
  return enabled;
}

export function vlog(message: string): void {
  if (enabled) process.stderr.write(`# ${message}\n`);
}

export function ms(since: number): string {
  return `${(performance.now() - since).toFixed(0)}ms`;
}
