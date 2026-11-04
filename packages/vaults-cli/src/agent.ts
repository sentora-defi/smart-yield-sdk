/**
 * Agent-host detection, used to make network-failure hints actionable for the
 * sandbox the CLI actually runs in. Env contracts (as of 2026):
 *  - Claude Code sets CLAUDECODE=1 in every subprocess.
 *  - Codex sets CODEX_SANDBOX (e.g. 'seatbelt') and, when the sandbox blocks
 *    egress, CODEX_SANDBOX_NETWORK_DISABLED=1 — connect() fails with EPERM.
 *  - Gemini CLI sets GEMINI_CLI=1.
 */
export type AgentHost = 'claude-code' | 'codex' | 'gemini-cli';

export function agentHost(env: NodeJS.ProcessEnv = process.env): AgentHost | undefined {
  if (env.CODEX_SANDBOX !== undefined || env.CODEX_SANDBOX_NETWORK_DISABLED !== undefined) return 'codex';
  if (env.CLAUDECODE === '1') return 'claude-code';
  if (env.GEMINI_CLI === '1') return 'gemini-cli';
  return undefined;
}

export function sandboxNetworkDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODEX_SANDBOX_NETWORK_DISABLED === '1';
}
