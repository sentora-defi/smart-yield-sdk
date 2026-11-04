/**
 * Minimal fetch client for the Sentora yields API. Response types are
 * generated from the API's OpenAPI spec into ./openapi.
 */
import type { paths } from './openapi.js';

type Ok<P extends keyof paths, M extends keyof paths[P] = 'get' & keyof paths[P]> =
  paths[P][M] extends { responses: { 200: { content: { 'application/json': infer T } } } } ? T : never;

export type YieldsVault = Ok<'/vaults'>[number];
export type YieldsToken = NonNullable<YieldsVault['depositToken']>;
export type YieldsVaultContracts = NonNullable<YieldsVault['contracts']>;
export type YieldsActiveVault = Ok<'/users/{wallet}/positions'>[number];

export type YieldsProtocolInsights = Ok<'/vaults/protocol/{blockchain}/{protocol}/{marketId}?'>;
export type YieldsVaultMainInsights = Ok<'/vaults/{chainId}/{address}/main-insights'>;

export type YieldsStrategyMetrics = Ok<'/strategies/positions/{positionId}/metric'>;
export type YieldsStrategyMetricPoint = NonNullable<YieldsStrategyMetrics['metrics']>[number];

type AllocationDistributionSpec = Ok<'/strategies/positions/allocation-distribution/chart', 'post'>;
export type YieldsAllocationEntry = AllocationDistributionSpec['metadata'][number];
// the spec renders zod tuples as unknown[]
export type YieldsAllocationMetricRow = [timestamp: number, ...values: (number | null)[]];
export type YieldsAllocationDistribution = Omit<AllocationDistributionSpec, 'metric'> & {
  metric: YieldsAllocationMetricRow[];
};

export type YieldsMetricSeriesPoint = [timestamp: number, value: number];
export type YieldsVaultAnalytics = {
  [K in keyof Ok<'/vaults/{chainId}/{address}/analytics'>]?: YieldsMetricSeriesPoint[];
};

export type YieldsUserVaultBalance = Ok<'/vaults/{chainId}/{address}/users/{wallet}/balance'>;
export type YieldsVaultUserActivity = Ok<'/vaults/{chainId}/{address}/users/{wallet}/activity'>[number];
export type YieldsVaultRiskIndicators = Ok<'/vaults/{chainId}/{address}/risk-indicators'>;
export type YieldsBlockchain = Ok<'/blockchains'>[number];
export type YieldsProtocolTvl = Ok<'/protocols/{protocol}/tvl'>;
export type YieldsPulseMetadata = Ok<'/pulse/metadata'>;
export type YieldsPulseNotification = Ok<'/pulse/notifications'>[number];

export interface RequestOpts {
  signal?: AbortSignal;
}

// must cover every legacy non-EVM name or numeric id the API returns, or a numeric one falls through to eip155; keys match case-insensitively
const NON_EVM_CAIP2: Record<string, string> = {
  solana: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  stellar: 'stellar:pubnet',
  '1399811149': 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
};

const CAIP2_RE = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;

/** Maps legacy numeric EVM ids (`'1'` → `'eip155:1'`) and known non-EVM names or ids (`'Solana'`) to CAIP-2; anything else, CAIP-2 included, is returned unchanged. */
export function toCaip2ChainId(chainId: string): string {
  if (CAIP2_RE.test(chainId)) return chainId;
  const nonEvm = chainId.toLowerCase();
  if (Object.hasOwn(NON_EVM_CAIP2, nonEvm)) return NON_EVM_CAIP2[nonEvm];
  if (/^\d+$/.test(chainId)) return `eip155:${chainId}`;
  return chainId;
}

/** Positive safe-integer chain id from a lower-case `eip155:<n>` or a legacy numeric EVM id; `undefined` for anything else (non-EVM chains, slugs, hex, upper case, 0). */
export function evmChainId(chainId: string): number | undefined {
  const m = /^eip155:(\d+)$/.exec(toCaip2ChainId(chainId));
  const n = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

export interface YieldsApiErrorBody {
  hasError?: boolean;
  message?: string;
  status?: number;
  errors?: unknown[];
}

const MAX_ERROR_BODY_CHARS = 300;

/** Upstream bodies are untrusted (WAF pages, hostile servers) — collapse control chars and cap length before they become error messages. */
function sanitizeUpstreamMessage(raw: string, fallback: string): string {
  let flat = '';
  for (const c of raw) {
    const n = c.codePointAt(0) ?? 0;
    flat += n < 32 || n === 127 ? ' ' : c;
  }
  const compact = flat.replace(/ {2,}/g, ' ').trim();
  if (!compact) return fallback;
  return compact.length > MAX_ERROR_BODY_CHARS ? `${compact.slice(0, MAX_ERROR_BODY_CHARS)}… [truncated]` : compact;
}

export class YieldsApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    body: YieldsApiErrorBody | string | null,
  ) {
    const fallback = `HTTP ${status} on ${path}`;
    const message = typeof body === 'string' ? body : body?.message;
    super(sanitizeUpstreamMessage(typeof message === 'string' ? message : fallback, fallback));
    this.name = 'YieldsApiError';
  }
}

/** Production API deployment; override via `baseUrl`. */
export const DEFAULT_BASE_URL = 'https://services.vaults.sentora.com';

declare const __YIELDS_CLIENT_VERSION__: string | undefined;

export const CLIENT_VERSION: string =
  typeof __YIELDS_CLIENT_VERSION__ === 'string' ? __YIELDS_CLIENT_VERSION__ : '0.0.0-dev';

/**
 * Honest self-identifying UA in the common "compatible" crawler convention
 * (see the RFC 9309 §2.2.1 example). The API answers 403 to other formats
 * (plain `name/version`, curl, node), so keep this shape when overriding
 * `userAgent`. Chrome drops a custom User-Agent in browser fetch; Firefox sends
 * it, which triggers a CORS preflight.
 */
export const DEFAULT_USER_AGENT = `Mozilla/5.0 (compatible; sentora-yields-client/${CLIENT_VERSION}; +https://sentora.com)`;

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

/** The x-api-key header travels on every request — refuse transports that expose it (plain http off-loopback). */
function assertSafeBaseUrl(baseUrl: string): void {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new Error(`@sentora/yields-client: baseUrl is not a valid URL.`);
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(u.hostname))) {
    throw new Error(
      `@sentora/yields-client: baseUrl must be https (plain http is allowed only for loopback hosts), got origin '${u.origin}'.`,
    );
  }
}

const enc = encodeURIComponent;

export interface YieldsClientOptions {
  /** defaults to the production deployment (DEFAULT_BASE_URL) */
  baseUrl?: string;
  apiKey?: string;
  /** defaults to DEFAULT_USER_AGENT; identify your integration when embedding this client */
  userAgent?: string;
  fetchImpl?: typeof fetch;
}

export class YieldsClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;

  /**
   * Creates a client for the Sentora yields API.
   *
   * @param opts Client options: `baseUrl` (defaults to DEFAULT_BASE_URL;
   *   trailing slashes are stripped; must be https, plain http is allowed only
   *   for loopback hosts), `apiKey` (sent as the `x-api-key` header on every
   *   request; when set, the client refuses to follow redirects so the key
   *   cannot leak cross-origin), `userAgent` (defaults to DEFAULT_USER_AGENT),
   *   and `fetchImpl` (custom fetch, defaults to the global fetch).
   */
  constructor(opts: YieldsClientOptions = {}) {
    let baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    while (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
    assertSafeBaseUrl(baseUrl);
    this.baseUrl = baseUrl;
    this.apiKey = opts.apiKey;
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
    // a detached global fetch throws "Illegal invocation" when called as a method in a browser
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  private async get<T>(
    path: string,
    query?: Record<string, string | number | boolean | string[] | undefined>,
    opts?: RequestOpts,
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(k, String(item));
      } else {
        url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': this.userAgent };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;

    const res = await this.fetchImpl(url, { headers, redirect: this.redirectMode(), signal: opts?.signal });
    return this.handleResponse<T>(res, path);
  }

  // fetch forwards custom headers (x-api-key) across cross-origin redirects, so refuse to follow when a key is set
  private redirectMode(): RequestRedirect {
    return this.apiKey ? 'error' : 'follow';
  }

  private async handleResponse<T>(res: Response, path: string): Promise<T> {
    const text = await res.text();
    if (!res.ok) {
      let errorBody: YieldsApiErrorBody | string;
      try {
        errorBody = JSON.parse(text) as YieldsApiErrorBody;
      } catch {
        errorBody = text;
      }
      throw new YieldsApiError(res.status, path, errorBody);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new YieldsApiError(res.status, path, `expected a JSON body, got: ${text}`);
    }
  }

  private async post<T>(path: string, payload: unknown, opts?: RequestOpts): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': this.userAgent,
    };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;

    const res = await this.fetchImpl(new URL(this.baseUrl + path), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      redirect: this.redirectMode(),
      signal: opts?.signal,
    });
    return this.handleResponse<T>(res, path);
  }

  /**
   * Lists the active vaults. GET /vaults
   *
   * @param opts Per-request options (`signal` to abort).
   * @returns The active vaults, highest TVL first. Onboarding and paused
   *   vaults are not listed.
   */
  listVaults(opts?: RequestOpts): Promise<YieldsVault[]> {
    return this.get('/vaults', undefined, opts);
  }

  /**
   * Lists the vaults curated as featured. GET /vaults/featured
   *
   * @param opts Per-request options (`signal` to abort).
   * @returns The featured vaults.
   */
  listFeaturedVaults(opts?: RequestOpts): Promise<YieldsVault[]> {
    return this.get('/vaults/featured', undefined, opts);
  }

  /**
   * Fetches a single vault. GET /vaults/:chainId/:address
   *
   * @param chainId Chain id the vault is deployed on.
   * @param address Vault contract address.
   * @param opts Per-request options (`signal` to abort).
   * @returns The vault details.
   */
  getVault(chainId: string, address: string, opts?: RequestOpts): Promise<YieldsVault> {
    return this.get(`/vaults/${enc(chainId)}/${enc(address)}`, undefined, opts);
  }

  /**
   * Fetches historical metric series for a vault.
   * GET /vaults/:chainId/:address/analytics — days is mutually exclusive with since/until.
   *
   * @param chainId Chain id the vault is deployed on.
   * @param address Vault contract address.
   * @param params Optional filters: `since`/`until` (ISO date range),
   *   `metric` (one or more series names to include), `days` (trailing window,
   *   mutually exclusive with since/until).
   * @param opts Per-request options (`signal` to abort).
   * @returns Metric series keyed by name (tvl, apy, ...), each an array of
   *   [timestamp, value] points.
   */
  getVaultAnalytics(
    chainId: string, address: string,
    params?: { since?: string; until?: string; metric?: string | string[]; days?: number },
    opts?: RequestOpts,
  ): Promise<YieldsVaultAnalytics> {
    return this.get(`/vaults/${enc(chainId)}/${enc(address)}/analytics`, params, opts);
  }

  /**
   * Fetches risk indicators for a vault. GET /vaults/:chainId/:address/risk-indicators
   *
   * @param chainId Chain id the vault is deployed on.
   * @param address Vault contract address.
   * @param opts Per-request options (`signal` to abort).
   * @returns The vault's risk indicators, one entry per configured indicator.
   */
  getVaultRiskIndicators(chainId: string, address: string, opts?: RequestOpts): Promise<YieldsVaultRiskIndicators> {
    return this.get(`/vaults/${enc(chainId)}/${enc(address)}/risk-indicators`, undefined, opts);
  }

  /**
   * Fetches a wallet's live balance in a vault.
   * GET /vaults/:chainId/:address/users/:wallet/balance
   *
   * @param chainId Chain id the vault is deployed on.
   * @param address Vault contract address.
   * @param wallet User wallet address.
   * @param opts Per-request options (`signal` to abort).
   * @returns Live share and USD balance figures for the wallet.
   */
  getUserVaultBalance(chainId: string, address: string, wallet: string, opts?: RequestOpts): Promise<YieldsUserVaultBalance> {
    return this.get(`/vaults/${enc(chainId)}/${enc(address)}/users/${enc(wallet)}/balance`, undefined, opts);
  }

  /**
   * Fetches a wallet's transaction history in a vault.
   * GET /vaults/:chainId/:address/users/:wallet/activity
   *
   * @param chainId Chain id the vault is deployed on.
   * @param address Vault contract address.
   * @param wallet User wallet address.
   * @param opts Per-request options (`signal` to abort).
   * @returns Deposit/withdraw activity entries for the wallet.
   */
  getUserVaultActivity(chainId: string, address: string, wallet: string, opts?: RequestOpts): Promise<YieldsVaultUserActivity[]> {
    return this.get(`/vaults/${enc(chainId)}/${enc(address)}/users/${enc(wallet)}/activity`, undefined, opts);
  }

  /**
   * Fetches a wallet's cross-chain portfolio of vault positions.
   * GET /users/:wallet/positions
   *
   * @param wallet User wallet address.
   * @param opts Per-request options (`signal` to abort).
   * @returns Vaults the wallet holds positions in, with user metrics attached.
   */
  getUserPositions(wallet: string, opts?: RequestOpts): Promise<YieldsActiveVault[]> {
    return this.get(`/users/${enc(wallet)}/positions`, undefined, opts);
  }

  /**
   * Lists the blockchains supported by the service. GET /blockchains
   *
   * @param opts Per-request options (`signal` to abort).
   * @returns Supported blockchains with explorer URLs and metadata.
   */
  listBlockchains(opts?: RequestOpts): Promise<YieldsBlockchain[]> {
    return this.get('/blockchains', undefined, opts);
  }

  /**
   * Fetches vaults related to a given vault. GET /vaults/related/:chainId/:address
   *
   * @param chainId Chain id the vault is deployed on.
   * @param address Vault contract address.
   * @param opts Per-request options (`signal` to abort).
   * @returns The related vaults.
   */
  getRelatedVaults(chainId: string, address: string, opts?: RequestOpts): Promise<YieldsVault[]> {
    return this.get(`/vaults/related/${enc(chainId)}/${enc(address)}`, undefined, opts);
  }

  /**
   * Fetches supply/debt insights for an underlying protocol.
   * GET /vaults/protocol/:blockchain/:protocol[/:marketId]
   *
   * @param blockchain Blockchain slug or chain id.
   * @param protocol Protocol identifier.
   * @param marketId Optional market within the protocol; omitted from the path
   *   when not provided.
   * @param opts Per-request options (`signal` to abort).
   * @returns Protocol supply/debt metrics.
   */
  getProtocolInsights(blockchain: string, protocol: string, marketId?: string, opts?: RequestOpts): Promise<YieldsProtocolInsights> {
    const base = `/vaults/protocol/${enc(blockchain)}/${enc(protocol)}`;
    return this.get(marketId ? `${base}/${enc(marketId)}` : base, undefined, opts);
  }

  /**
   * Fetches supply/debt insights for the DeFi Risk market a vault lends into.
   * GET /vaults/:chainId/:address/main-insights
   *
   * @param chainId Chain id the vault is deployed on (CAIP-2, legacy id or slug).
   * @param address Vault contract address.
   * @param opts Per-request options (`signal` to abort).
   * @returns Market supply/debt metrics plus the resolved `market`; vaults
   *   without a DeFi Risk market get an empty `metric` and no `market`.
   */
  getVaultMainInsights(chainId: string, address: string, opts?: RequestOpts): Promise<YieldsVaultMainInsights> {
    return this.get(`/vaults/${enc(chainId)}/${enc(address)}/main-insights`, undefined, opts);
  }

  /**
   * Fetches the metric time series for a strategy position.
   * GET /strategies/positions/:positionId/metric
   *
   * @param positionId Strategy position identifier.
   * @param params Query params: `vaultAddress`/`vaultChainId` identify the
   *   vault and are required by the service (optional only in this signature);
   *   optional `since`/`until` (ISO date range) and `refresh` (request fresh
   *   data upstream).
   * @param opts Per-request options (`signal` to abort).
   * @returns Position metadata and its metric points.
   */
  getStrategyMetrics(
    positionId: string,
    params?: { vaultAddress?: string; vaultChainId?: string; since?: string; until?: string; refresh?: boolean },
    opts?: RequestOpts,
  ): Promise<YieldsStrategyMetrics> {
    return this.get(`/strategies/positions/${enc(positionId)}/metric`, params, opts);
  }

  /**
   * Fetches the allocation distribution chart for a set of strategy positions.
   * POST /strategies/positions/allocation-distribution/chart
   *
   * @param payload Request body: `positions` (position ids to chart),
   *   `vaultAddress`/`vaultChainId` (required by the service; optional only in
   *   this signature), optional `since`/`until` (ISO date range) and `refresh`
   *   (request fresh data upstream).
   * @param opts Per-request options (`signal` to abort).
   * @returns Allocation entries and the last metric date.
   */
  getStrategyAllocationDistribution(
    payload: {
      positions: string[];
      vaultAddress?: string;
      vaultChainId?: string;
      since?: string | null;
      until?: string | null;
      refresh?: boolean;
    },
    opts?: RequestOpts,
  ): Promise<YieldsAllocationDistribution> {
    return this.post('/strategies/positions/allocation-distribution/chart', payload, opts);
  }

  /**
   * Fetches a protocol's total value locked. GET /protocols/:protocol/tvl
   *
   * @param protocol Protocol identifier.
   * @param opts Per-request options (`signal` to abort).
   * @returns The protocol TVL value.
   */
  getProtocolTvl(protocol: string, opts?: RequestOpts): Promise<YieldsProtocolTvl> {
    return this.get(`/protocols/${enc(protocol)}/tvl`, undefined, opts);
  }

  /**
   * Fetches Pulse notification metadata. GET /pulse/metadata
   *
   * @param opts Per-request options (`signal` to abort).
   * @returns Pulse protocols, blockchains, notification types and policies.
   */
  getPulseMetadata(opts?: RequestOpts): Promise<YieldsPulseMetadata> {
    return this.get('/pulse/metadata', undefined, opts);
  }

  /**
   * Fetches Pulse notifications. GET /pulse/notifications
   *
   * @param query Optional filters: `vaultAddresses`/`vaultChainIds` (restrict
   *   to specific vaults; must be provided together with equal lengths, paired
   *   by index), `limit` (page size), `last_evaluated_key`
   *   (pagination cursor from a previous page).
   * @param opts Per-request options (`signal` to abort).
   * @returns The matching notifications.
   */
  getPulseNotifications(
    query?: { vaultAddresses?: string[]; vaultChainIds?: string[]; limit?: number; last_evaluated_key?: string },
    opts?: RequestOpts,
  ): Promise<YieldsPulseNotification[]> {
    return this.get('/pulse/notifications', query, opts);
  }
}
