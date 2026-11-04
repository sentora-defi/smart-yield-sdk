import { isContractRevert, isGasCapError } from '@sentora/vaults-plan';
import { agentHost, sandboxNetworkDisabled } from './agent';

export type ErrorCode =
  | 'USAGE'
  | 'NOT_FOUND'
  | 'RPC_ERROR'
  | 'UPSTREAM_API'
  | 'CONTRACT_ERROR'
  | 'UNEXPECTED';

export const EXIT_CODES: Record<ErrorCode, number> = {
  UNEXPECTED: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  RPC_ERROR: 4,
  UPSTREAM_API: 5,
  CONTRACT_ERROR: 6,
};

/** not an error: the plan printed fine but has blockers — callers must not execute it */
export const EXIT_PLAN_BLOCKED = 7;

export class CliError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly hint?: string;

  constructor(code: ErrorCode, message: string, opts: { retryable?: boolean; hint?: string } = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.hint = opts.hint;
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }
}

const RPC_ERROR_NAMES = new Set(['HttpRequestError', 'TimeoutError', 'RpcRequestError', 'SocketClosedError', 'WebSocketRequestError']);

const MAX_ERROR_MESSAGE_CHARS = 500;

/**
 * Error messages carry untrusted content (revert reasons, upstream bodies) and
 * end up in agent-consumed output — collapse control chars and cap length.
 */
export function sanitizeErrorMessage(raw: string): string {
  let flat = '';
  for (const c of raw) {
    const n = c.codePointAt(0) ?? 0;
    flat += n < 32 || n === 127 ? ' ' : c;
  }
  const compact = flat.replace(/ {2,}/g, ' ').trim();
  return compact.length > MAX_ERROR_MESSAGE_CHARS
    ? `${compact.slice(0, MAX_ERROR_MESSAGE_CHARS)}… [truncated]`
    : compact;
}

/** viem wraps transport failures (e.g. readContract → ContractFunctionExecutionError with an HttpRequestError cause) — walk the cause chain */
function causeChainHas(e: unknown, names: Set<string>): boolean {
  let cur = e as { name?: string; cause?: unknown } | undefined;
  for (let depth = 0; cur && typeof cur === 'object' && depth < 8; depth++) {
    if (cur.name && names.has(cur.name)) return true;
    cur = cur.cause as { name?: string; cause?: unknown } | undefined;
  }
  return false;
}

export function isRpcShapedError(e: unknown): boolean {
  return causeChainHas(e, RPC_ERROR_NAMES);
}

/** socket/DNS failure codes */
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
  'ENETUNREACH', 'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);

const SANDBOX_DENIAL_CODES = new Set(['EPERM', 'EACCES']);

function causeChainNetworkCode(e: unknown): string | undefined {
  const sandboxed = sandboxNetworkDisabled() || agentHost() === 'codex';
  let cur = e as { code?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; cur && typeof cur === 'object' && depth < 8; depth++) {
    if (typeof cur.code === 'string' && (NETWORK_ERROR_CODES.has(cur.code) || (sandboxed && SANDBOX_DENIAL_CODES.has(cur.code)))) {
      return cur.code;
    }
    cur = cur.cause as { code?: unknown; cause?: unknown } | undefined;
  }
  return undefined;
}

export function networkFailureOpts(verify: string): { retryable: boolean; hint: string } {
  if (sandboxNetworkDisabled()) {
    return {
      retryable: false,
      hint:
        'Network egress is disabled by the Codex sandbox (CODEX_SANDBOX_NETWORK_DISABLED=1) — retrying will not help. ' +
        "Enable it via `[sandbox_workspace_write] network_access = true` in ~/.codex/config.toml, or re-run the command with an approved escalation.",
    };
  }
  const host = agentHost();
  const sandboxNote = host
    ? ` If this persists, the ${host} sandbox may be blocking network egress — approve network access or allowlist this domain.`
    : '';
  return { retryable: true, hint: `${verify} and retry.${sandboxNote}` };
}

export function toCliError(e: unknown): CliError {
  if (e instanceof CliError) return e;
  const err = e as { name?: string; shortMessage?: string; message?: string; status?: number };
  const name = err?.name ?? '';
  const message = sanitizeErrorMessage(err?.shortMessage ?? err?.message ?? String(e));

  if (name === 'YieldsApiError') {
    const status = err.status ?? 0;
    if (status === 404) {
      return new CliError('NOT_FOUND', message, {
        hint: 'If it should exist, check the API base URL (--base-url, YIELDS_BASE_URL or SENTORA_API_URL).',
      });
    }
    return new CliError('UPSTREAM_API', message, {
      retryable: status >= 500 || status === 429,
      hint:
        status === 401 || status === 403
          ? 'Authentication failed — set YIELDS_API_KEY (or SENTORA_API_KEY).'
          : undefined,
    });
  }
  if (isGasCapError(e)) {
    return new CliError('RPC_ERROR', message, {
      retryable: false,
      hint: "The RPC's eth_call gas cap is lower than this read needs — retrying the same endpoint will not help; use an RPC with a higher gas cap.",
    });
  }
  if (isRpcShapedError(e) && !isContractRevert(e)) {
    return new CliError('RPC_ERROR', message, networkFailureOpts('RPC/network failure — verify --rpc-url (or VAULTS_RPC_URL)'));
  }
  const netCode = causeChainNetworkCode(e);
  if (netCode !== undefined || (name === 'TypeError' && /fetch failed/i.test(message))) {
    return new CliError(
      'RPC_ERROR',
      `Network request failed${netCode ? ` (${netCode})` : ''}: ${message}`,
      networkFailureOpts('Verify the endpoint is reachable'),
    );
  }
  if (causeChainHas(e, new Set(['IntegerOutOfRangeError', 'InvalidAddressError']))) {
    return new CliError('USAGE', message, {
      hint: 'An input is out of range for the contract ABI slot — check numeric flags (bps, deadline) and addresses.',
    });
  }
  if (name.startsWith('ContractFunction') || name.startsWith('AbiDecoding') || name === 'CallExecutionError') {
    return new CliError('CONTRACT_ERROR', message, {
      retryable: false,
      hint: 'The read reverted or returned no data — check the address is the right contract on the chain served by --rpc-url.',
    });
  }
  return new CliError('UNEXPECTED', message);
}
