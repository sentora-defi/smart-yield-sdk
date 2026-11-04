declare const __VAULTS_CLI_VERSION__: string | undefined;

export const VERSION: string =
  typeof __VAULTS_CLI_VERSION__ === 'string' ? __VAULTS_CLI_VERSION__ : '0.0.0-dev';

/**
 * Version of the CLI-owned output envelopes (plan results and `describe`).
 * Bump on any breaking change to their shape — agents pin automations to it.
 */
export const SCHEMA_VERSION = 1;
