import { DEFAULT_BASE_URL, YieldsClient, toCaip2ChainId, type YieldsVault } from '@sentora/yields-client';
import { CliError } from '../errors';
import { makeFetch, optionalInt, requireString, requireAddress, shown } from '../helpers';
import { vlog } from '../verbose';
import { VERSION } from '../version';
import type { CommandDef, Flags, OptSpec } from '../types';

const USER_AGENT = `Mozilla/5.0 (compatible; smart-yield-cli/${VERSION}; +https://sentora.com)`;

export const baseOpts: Record<string, OptSpec> = {
  'base-url': { type: 'string', placeholder: '<url>', description: `Sentora yields API base URL (default ${DEFAULT_BASE_URL}; env YIELDS_BASE_URL or SENTORA_API_URL override). The API key (env YIELDS_API_KEY or SENTORA_API_KEY) is only sent to the default or env-configured origins.` },
};
const chainId: OptSpec = { type: 'string', required: true, placeholder: '<id>', description: "Chain id: slug ('ethereum'), legacy ('1') or CAIP-2 ('eip155:1')." };
const address: OptSpec = { type: 'string', required: true, placeholder: '<address>', description: 'Vault address (0x, Solana base58 or Stellar C… contract).' };
const wallet: OptSpec = { type: 'string', required: true, placeholder: '<address>', description: 'User wallet address (0x, Solana base58 or Stellar G…).' };

const CHAIN_ID_RE = /^[A-Za-z0-9_:-]{1,64}$/;

/** chain ids travel as URL path segments — reject separators before they reach the client */
function requireChainId(flags: Flags): string {
  const v = requireString(flags, 'chain-id');
  if (!CHAIN_ID_RE.test(v)) {
    throw new CliError('USAGE', `--chain-id must be 1-64 letters, digits, '-', '_' or ':', got '${shown(v)}'.`);
  }
  return v;
}

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const STELLAR_ID_RE = /^[CG][A-Z2-7]{55}$/;
const BARE_EVM_HEX_RE = /^[0-9a-fA-F]{40}$/;

function requireChainAddress(flags: Flags, name: string): string {
  const v = typeof flags[name] === 'string' ? (flags[name] as string) : '';
  if (!v || v.startsWith('0x') || BARE_EVM_HEX_RE.test(v)) return requireAddress(flags, name);
  if (SOLANA_ADDRESS_RE.test(v) || STELLAR_ID_RE.test(v)) return v;
  throw new CliError('USAGE', `--${name} must be a 0x EVM address, a Solana base58 address or a Stellar G…/C… id, got '${shown(v)}'.`);
}

const CAIP2_RE = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;

export const SUPPORTED_VAULT_SCHEMA_VERSION = 1;

export function catalogVaults(raw: unknown): { vaults: YieldsVault[]; error?: string } {
  if (!Array.isArray(raw)) return { vaults: [], error: 'GET /vaults did not return a list' };
  const vaults = raw.filter((v): v is YieldsVault => typeof v === 'object' && v !== null && !Array.isArray(v));
  const unsupported = vaults.find((v) => v.schemaVersion !== SUPPORTED_VAULT_SCHEMA_VERSION);
  if (unsupported) return { vaults: [], error: `unsupported vault schemaVersion ${String(unsupported.schemaVersion)}` };
  return { vaults };
}

async function resolveChain(api: YieldsClient, input: string, signal: AbortSignal): Promise<string> {
  const caip2 = toCaip2ChainId(input);
  if (CAIP2_RE.test(caip2) && !/^eip155:(?![1-9]\d*$)/.test(caip2)) return caip2.toLowerCase();
  const want = input.toLowerCase();
  const match = (await api.listBlockchains({ signal })).find((b) => b.slug?.toLowerCase() === want);
  if (!match) {
    throw new CliError('USAGE', `Unknown chain '${input.slice(0, 64)}'.`, { hint: "Use a chain id ('1', 'eip155:1') or a slug from 'smart-yield yields blockchains'." });
  }
  return toCaip2ChainId(match.chainId).toLowerCase();
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
  } catch {
    return false;
  }
}

export function client(flags: Flags): YieldsClient {
  const sources: [string, string | undefined][] = [
    ['--base-url', typeof flags['base-url'] === 'string' ? flags['base-url'] : undefined],
    ['YIELDS_BASE_URL', process.env.YIELDS_BASE_URL],
    ['SENTORA_API_URL', process.env.SENTORA_API_URL],
  ];
  const [source, baseUrl] = (sources.find(([, v]) => v) as [string, string] | undefined) ?? ['default', DEFAULT_BASE_URL];
  const origin = originOf(baseUrl);
  if (!origin) {
    throw new CliError('USAGE', `The yields base URL (from ${source}) is not a valid URL.`);
  }
  if (!origin.startsWith('https:') && !isLoopback(baseUrl)) {
    throw new CliError('USAGE', `The yields base URL must be https (plain http is allowed only for loopback hosts), got origin '${origin}'.`);
  }
  const apiKey = process.env.YIELDS_API_KEY ?? process.env.SENTORA_API_KEY;
  // The key is an org credential: never attach it to a per-invocation flag origin
  // that isn't also the default or an operator-configured (env) origin.
  if (apiKey && source === '--base-url') {
    const allowed = new Set(
      [DEFAULT_BASE_URL, process.env.YIELDS_BASE_URL, process.env.SENTORA_API_URL]
        .filter((u): u is string => typeof u === 'string')
        .map(originOf)
        .filter(Boolean),
    );
    if (!allowed.has(origin)) {
      throw new CliError('USAGE', `Refusing to send the configured API key to non-default origin '${origin}'.`, {
        hint: 'Point YIELDS_BASE_URL (or SENTORA_API_URL) at that origin instead, or unset YIELDS_API_KEY/SENTORA_API_KEY to query it without the key.',
      });
    }
  }
  vlog(`yields api: ${baseUrl} (from ${source}${apiKey ? ', with api key' : ''})`);
  return new YieldsClient({ baseUrl, apiKey, userAgent: USER_AGENT, fetchImpl: makeFetch(flags) });
}

/** summary stats for a [ts, value][] series — sizes are API-controlled and can exceed the spread-argument limit */
export function summarizeSeries(series: [number, number][]): Record<string, number> {
  let min = series[0][1];
  let max = series[0][1];
  let sum = 0;
  for (const [, y] of series) {
    if (y < min) min = y;
    if (y > max) max = y;
    sum += y;
  }
  return {
    points: series.length,
    from: series[0][0],
    to: series[series.length - 1][0],
    latest: series[series.length - 1][1],
    min,
    max,
    mean: sum / series.length,
  };
}

export const yieldsCommands: CommandDef[] = [
  {
    family: 'yields',
    name: 'list',
    summary: 'Vault catalog from the API: family, vendor, curator and the contracts each adapter needs.',
    options: {
      ...baseOpts,
      featured: { type: 'boolean', description: 'Only featured vaults.' },
      chain: { type: 'string', placeholder: '<id>', description: "Filter by chain: slug ('ethereum'), legacy id ('1') or CAIP-2 ('eip155:1')." },
      'family': { type: 'string', placeholder: '<family>', description: 'Exact match on the vault family (morpho, boring, upshift_evm, …).' },
      curator: { type: 'string', placeholder: '<name>', description: 'Exact match on the curator.' },
      vendor: { type: 'string', placeholder: '<name>', description: 'Exact match on the vault vendor (morpho, veda, upshift, …).' },
      limit: { type: 'string', placeholder: '<n>', description: 'Return at most N vaults; combine with --offset to page. The response reports total/offset/truncated/remaining.' },
      offset: { type: 'string', placeholder: '<n>', description: 'Skip the first N vaults (after filtering, default 0).' },
      fields: { type: 'string', placeholder: 'a,b,c', description: 'Comma-separated field projection per vault (e.g. chainId,name,family,contracts).' },
    },
    examples: [
      'smart-yield yields list --chain eip155:1 --fields "name,family,contracts"',
      'smart-yield yields list --family upshift_evm',
      'smart-yield yields list --limit 10 --offset 10',
    ],
    run: async (flags) => {
      const offset = optionalInt(flags, 'offset') ?? 0;
      const limit = optionalInt(flags, 'limit');
      const api = client(flags);
      const abort = new AbortController();
      const chainLookup = typeof flags.chain === 'string'
        ? resolveChain(api, flags.chain, abort.signal).catch((e: unknown) => { abort.abort(); throw e; })
        : undefined;
      const [chain, raw] = await Promise.all([chainLookup, api.listVaults({ signal: abort.signal })]);
      const catalog = catalogVaults(raw);
      if (catalog.error) throw new CliError('UPSTREAM_API', catalog.error);
      let vaults = catalog.vaults;
      if (flags.featured === true) vaults = vaults.filter((v) => v.featured === true);
      if (chain) vaults = vaults.filter((v) => typeof v.chainId === 'string' && toCaip2ChainId(v.chainId).toLowerCase() === chain);
      const eq = (name: string, get: (v: YieldsVault) => unknown) => {
        const want = typeof flags[name] === 'string' ? (flags[name] as string).toLowerCase() : undefined;
        if (want) vaults = vaults.filter((v) => {
          const got = get(v);
          return typeof got === 'string' && got.toLowerCase() === want;
        });
      };
      eq('family', (v) => v.family);
      eq('curator', (v) => v.curator);
      eq('vendor', (v) => v.vendor);
      const total = vaults.length;
      vaults = vaults.slice(offset, limit === undefined ? undefined : offset + limit);
      const fields = typeof flags.fields === 'string' ? flags.fields.split(',').map((f) => f.trim()) : undefined;
      const rows = fields ? vaults.map((v: Record<string, unknown>) => Object.fromEntries(fields.map((f) => [f, v[f]]))) : vaults;
      const remaining = total - offset - rows.length;
      return {
        total,
        offset,
        returned: rows.length,
        truncated: remaining > 0,
        remaining: Math.max(0, remaining),
        vaults: rows,
      };
    },
  },
  {
    family: 'yields',
    name: 'get',
    summary: 'One vault by chain id + address.',
    options: { ...baseOpts, 'chain-id': chainId, address },
    examples: ['smart-yield yields get --chain-id 1 --address 0xVAULT'],
    run: async (flags) => client(flags).getVault(requireChainId(flags), requireChainAddress(flags, 'address')),
  },
  {
    family: 'yields',
    name: 'analytics',
    summary: 'Vault analytics time series. --days is mutually exclusive with --since/--until. Use --summary or --last to avoid pulling full series into context.',
    options: {
      ...baseOpts,
      'chain-id': chainId,
      address,
      since: { type: 'string', placeholder: '<date>', description: 'Range start (ISO date).' },
      until: { type: 'string', placeholder: '<date>', description: 'Range end (ISO date).' },
      metric: { type: 'string', placeholder: '<name>', description: 'Restrict to one metric (e.g. apy, tvl).' },
      days: { type: 'string', placeholder: '<n>', description: 'Last N days, 1-36500 (mutually exclusive with --since/--until).' },
      last: { type: 'string', placeholder: '<n>', description: 'Keep only the last N points of each series (N >= 1).' },
      summary: { type: 'boolean', description: 'Reduce each series to {points, from, to, latest, min, max, mean} instead of raw points.' },
    },
    examples: [
      'smart-yield yields analytics --chain-id 1 --address 0xVAULT --days 30 --summary',
      'smart-yield yields analytics --chain-id 1 --address 0xVAULT --days 3 --metric apy --last 5',
    ],
    run: async (flags) => {
      const days = optionalInt(flags, 'days', 36_500, 1);
      if (days !== undefined && (flags.since !== undefined || flags.until !== undefined)) {
        throw new CliError('USAGE', '--days is mutually exclusive with --since/--until.');
      }
      const last = optionalInt(flags, 'last', undefined, 1);
      const raw = await client(flags).getVaultAnalytics(requireChainId(flags), requireChainAddress(flags, 'address'), {
        since: typeof flags.since === 'string' ? flags.since : undefined,
        until: typeof flags.until === 'string' ? flags.until : undefined,
        metric: typeof flags.metric === 'string' ? flags.metric : undefined,
        days,
      });
      const summarize = flags.summary === true;
      if ((last === undefined && !summarize) || raw === null || typeof raw !== 'object') return raw;

      const isSeries = (v: unknown): v is [number, number][] =>
        Array.isArray(v) && v.length > 0 && v.every((p) => Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number');
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!isSeries(value)) { out[key] = value; continue; }
        const series = last === undefined ? value : value.slice(-last);
        if (!summarize) { out[key] = series; continue; }
        out[key] = summarizeSeries(series);
      }
      return out;
    },
  },
  {
    family: 'yields',
    name: 'risk',
    summary: 'Vault risk indicators.',
    options: { ...baseOpts, 'chain-id': chainId, address },
    examples: ['smart-yield yields risk --chain-id 1 --address 0xVAULT'],
    run: async (flags) => client(flags).getVaultRiskIndicators(requireChainId(flags), requireChainAddress(flags, 'address')),
  },
  {
    family: 'yields',
    name: 'main-insights',
    summary: 'Supply/debt of the DeFi Risk market a direct vault lends into. Empty metric (and no market) for vaults without one.',
    options: { ...baseOpts, 'chain-id': chainId, address },
    examples: ['smart-yield yields main-insights --chain-id eip155:1 --address 0xVAULT'],
    run: async (flags) => client(flags).getVaultMainInsights(requireChainId(flags), requireChainAddress(flags, 'address')),
  },
  {
    family: 'yields',
    name: 'balance',
    summary: "A wallet's balance in one vault.",
    options: { ...baseOpts, 'chain-id': chainId, address, wallet },
    examples: ['smart-yield yields balance --chain-id 1 --address 0xVAULT --wallet 0xWALLET'],
    run: async (flags) =>
      client(flags).getUserVaultBalance(requireChainId(flags), requireChainAddress(flags, 'address'), requireChainAddress(flags, 'wallet')),
  },
  {
    family: 'yields',
    name: 'activity',
    summary: "A wallet's activity in one vault.",
    options: { ...baseOpts, 'chain-id': chainId, address, wallet },
    examples: ['smart-yield yields activity --chain-id 1 --address 0xVAULT --wallet 0xWALLET'],
    run: async (flags) =>
      client(flags).getUserVaultActivity(requireChainId(flags), requireChainAddress(flags, 'address'), requireChainAddress(flags, 'wallet')),
  },
  {
    family: 'yields',
    name: 'positions',
    summary: 'Cross-chain portfolio for a wallet.',
    options: { ...baseOpts, wallet },
    examples: ['smart-yield yields positions --wallet 0xWALLET'],
    run: async (flags) => client(flags).getUserPositions(requireChainAddress(flags, 'wallet')),
  },
  {
    family: 'yields',
    name: 'blockchains',
    summary: 'Chains known to the yields API.',
    options: baseOpts,
    examples: ['smart-yield yields blockchains'],
    run: async (flags) => client(flags).listBlockchains(),
  },
];
