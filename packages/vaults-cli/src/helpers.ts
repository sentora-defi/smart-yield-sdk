import { createPublicClient, defineChain, http, isAddress as isChecksumValidAddress, parseAbi, parseUnits, type Address, type PublicClient, type Transport } from 'viem';
import { CliError, networkFailureOpts } from './errors';
import { isVerbose, ms, vlog } from './verbose';
import type { Flags, OptSpec } from './types';

const ADDRESS_HINT =
  "Mixed-case addresses are EIP-55 checksum-validated — a checksum failure usually means a transcription error. All-lowercase addresses skip the check.";

/** strict viem validation: hex shape + EIP-55 checksum when mixed-case */
export function isAddress(v: string): v is Address {
  return isChecksumValidAddress(v);
}

function str(flags: Flags, name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}

export function requireAddress(flags: Flags, name: string): Address {
  const v = str(flags, name);
  if (!v) throw new CliError('USAGE', `Missing required flag --${name} <address>.`);
  if (!isAddress(v)) {
    throw new CliError('USAGE', `--${name} must be a 0x-prefixed 20-byte hex address with a valid checksum, got '${shown(v)}'.`, { hint: ADDRESS_HINT });
  }
  return v;
}

export function optionalAddress(flags: Flags, name: string): Address | undefined {
  const v = str(flags, name);
  if (v === undefined) return undefined;
  if (!isAddress(v)) {
    throw new CliError('USAGE', `--${name} must be a 0x-prefixed 20-byte hex address with a valid checksum, got '${shown(v)}'.`, { hint: ADDRESS_HINT });
  }
  return v;
}

export function requireBigInt(flags: Flags, name: string): bigint {
  const v = str(flags, name);
  if (v === undefined) throw new CliError('USAGE', `Missing required flag --${name}.`);
  if (!/^\d+$/.test(v)) {
    throw new CliError('USAGE', `--${name} must be an unsigned integer, got '${shown(v)}'.`);
  }
  return BigInt(v);
}

export function optionalBigInt(flags: Flags, name: string): bigint | undefined {
  return str(flags, name) === undefined ? undefined : requireBigInt(flags, name);
}

export function requireString(flags: Flags, name: string): string {
  const v = str(flags, name);
  if (!v) throw new CliError('USAGE', `Missing required flag --${name}.`);
  return v;
}

/** A flag value as echoed in an error: at most 64 characters, with a marker when cut. */
export function shown(v: string): string {
  const chars = Array.from(v);
  return chars.length > 64 ? `${chars.slice(0, 64).join('')}…` : v;
}

export function optionalInt(flags: Flags, name: string, max?: number, min = 0): number | undefined {
  const v = str(flags, name);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new CliError('USAGE', `--${name} must be an unsigned integer, got '${shown(v)}'.`);
  const n = Number(v);
  if (max !== undefined && n > max) throw new CliError('USAGE', `--${name} must be <= ${max}, got '${shown(v)}'.`);
  if (!Number.isSafeInteger(n)) throw new CliError('USAGE', `--${name} is too large, got '${shown(v)}'.`);
  if (n < min) throw new CliError('USAGE', `--${name} must be >= ${min}, got '${shown(v)}'.`);
  return n;
}

// ---------- amounts (base units by default, decimal units with --human) ----------

export const humanOpt: OptSpec = {
  type: 'boolean',
  description: "Interpret amounts as human decimal units (e.g. '100.5'); token decimals are read on-chain. Default is base units.",
};

const decimalsAbi = parseAbi(['function decimals() view returns (uint8)']);
const assetAbi = parseAbi(['function asset() view returns (address)']);

/** underlying asset of an ERC-4626-style vault */
export async function erc4626Asset(pc: PublicClient, vault: Address): Promise<Address> {
  return pc.readContract({ address: vault, abi: assetAbi, functionName: 'asset' });
}

/** the token whose decimals scale an amount — resolved lazily, only when --human */
export type TokenRef = Address | (() => Promise<Address>);

async function toBaseUnits(pc: PublicClient, flags: Flags, name: string, v: string, token: TokenRef): Promise<bigint> {
  if (flags.human !== true) {
    if (!/^\d+$/.test(v)) {
      throw new CliError('USAGE', `--${name} must be an unsigned integer in base units, got '${shown(v)}'.`, {
        hint: 'Pass --human to use decimal units instead.',
      });
    }
    return BigInt(v);
  }
  if (!/^\d+(\.\d+)?$/.test(v)) {
    throw new CliError('USAGE', `--${name} with --human must be a decimal number, got '${shown(v)}'.`);
  }
  const address = typeof token === 'string' ? token : await token();
  const decimals = await pc.readContract({ address, abi: decimalsAbi, functionName: 'decimals' });
  const frac = v.split('.')[1] ?? '';
  if (frac.length > decimals) {
    throw new CliError('USAGE', `--${name}='${shown(v)}' has ${frac.length} fractional digits but the token has ${decimals} decimals.`);
  }
  const base = parseUnits(v, decimals);
  vlog(`--${name}: ${v} human × 10^${decimals} (decimals of ${address}) = ${base} base units`);
  return base;
}

export async function requireAmount(pc: PublicClient, flags: Flags, name: string, token: TokenRef): Promise<bigint> {
  const v = str(flags, name);
  if (v === undefined) throw new CliError('USAGE', `Missing required flag --${name} <amount>.`);
  return toBaseUnits(pc, flags, name, v, token);
}

export async function optionalAmount(pc: PublicClient, flags: Flags, name: string, token: TokenRef): Promise<bigint | undefined> {
  const v = str(flags, name);
  return v === undefined ? undefined : toBaseUnits(pc, flags, name, v, token);
}

// ---------- clients ----------

export function timeoutMs(flags: Flags): number {
  const v = str(flags, 'timeout');
  if (v === undefined) return 30_000;
  if (!/^\d+$/.test(v)) throw new CliError('USAGE', `--timeout must be milliseconds as an unsigned integer, got '${shown(v)}'.`);
  // Node clamps timers above 2^31-1 ms to 1 ms
  if (Number(v) > 2_147_483_647) throw new CliError('USAGE', `--timeout must be <= 2147483647 ms (about 24.8 days), got '${shown(v)}'.`);
  return Number(v);
}

/** Provider RPC URLs commonly embed the API key in the path — never log them verbatim. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname !== '/' || u.search ? '/…' : ''}`;
  } catch {
    return '<invalid-url>';
  }
}

export function makeClient(flags: Flags): PublicClient {
  const sources: [string, string | undefined][] = [
    ['--rpc-url', str(flags, 'rpc-url')],
    ['VAULTS_RPC_URL', process.env.VAULTS_RPC_URL],
    ['SENTORA_RPC_URL', process.env.SENTORA_RPC_URL],
    ['ETH_RPC_URL', process.env.ETH_RPC_URL],
  ];
  const resolved = sources.find(([, v]) => v);
  if (!resolved) {
    throw new CliError('USAGE', 'No RPC endpoint configured.', {
      hint: 'Pass --rpc-url <url> or set VAULTS_RPC_URL (SENTORA_RPC_URL / ETH_RPC_URL also honored). Use an endpoint on the chain the vault lives on, e.g. http://127.0.0.1:8545 for a local fork.',
    });
  }
  const [source, url] = resolved as [string, string];
  const multicall = flags['no-multicall'] !== true;
  const timeout = timeoutMs(flags);
  vlog(`rpc endpoint: ${redactUrl(url)} (from ${source}, ${timeout > 0 ? `timeout ${timeout}ms` : 'no timeout'}, multicall ${multicall ? 'on' : 'off'})`);
  const base = http(url, { timeout });
  const transport = isVerbose() ? withRequestLogging(base) : base;
  if (!multicall) return createPublicClient({ transport });
  // Same-tick reads aggregate into one Multicall3 eth_call — SDK Promise.all
  // fan-outs collapse from ~15 round trips to 1-2. The canonical Multicall3
  // address is deployed on virtually every chain; --no-multicall for the rest.
  const chain = defineChain({
    id: 0,
    name: 'rpc',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [url] } },
    contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
  });
  return createPublicClient({ chain, transport, batch: { multicall: true } }) as PublicClient;
}

/** wrap a viem transport so every JSON-RPC request logs method, target, and latency */
function withRequestLogging(base: Transport): Transport {
  let n = 0;
  return (args) => {
    const t = base(args);
    const request: typeof t.request = async (req, opts) => {
      const i = ++n;
      const to = (req as { params?: [{ to?: string }] }).params?.[0]?.to;
      const started = performance.now();
      try {
        return await t.request(req, opts);
      } finally {
        vlog(`rpc #${i} ${(req as { method: string }).method}${to ? ` → ${to}` : ''} ${ms(started)}`);
      }
    };
    return { ...t, request };
  };
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** fetch bounded by --timeout (0 = no limit, as for RPC calls), for the yields API; logs requests when --verbose */
export function makeFetch(flags: Flags): typeof fetch {
  const timeout = timeoutMs(flags);
  return async (input, init) => {
    const started = performance.now();
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const line = `http ${method} ${url}`;
    // fetch reads signal: undefined as "keep the Request's signal"; only null clears it
    const callerSignal = init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : undefined;
    const deadline = timeout > 0 ? new AbortController() : undefined;
    if (deadline) {
      // the abort reason is what both fetch() and a later body read reject with
      setTimeout(() => deadline.abort(new CliError(
        'RPC_ERROR',
        `Yields API request ${pathOf(url)} timed out after ${timeout} ms.`,
        networkFailureOpts('Check that the yields API is reachable (on the CLI, --timeout raises the limit)'),
      )), timeout).unref();
    }
    const signal = deadline ? (callerSignal ? AbortSignal.any([callerSignal, deadline.signal]) : deadline.signal) : callerSignal;
    const res = await fetch(input, { ...init, signal }).catch((e: unknown) => {
      vlog(`${line} → ${deadline?.signal.aborted ? `timed out after ${timeout} ms` : `failed after ${ms(started)}`}`);
      throw e;
    });
    vlog(`${line} → ${res.status} ${ms(started)}`);
    return res;
  };
}
