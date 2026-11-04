import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  YieldsClient,
  YieldsApiError,
  DEFAULT_BASE_URL,
  DEFAULT_USER_AGENT,
  CLIENT_VERSION,
  toCaip2ChainId,
  evmChainId,
} from '../../packages/yields-client/src/index.ts';

let server;
let origin;
let requests = [];
let handler;

const json = (status, body) => (req, res) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  requests = [];
  handler = json(200, { ok: true });
});

const last = () => requests.at(-1);

test('GET methods hit the expected path and query', async (t) => {
  const c = new YieldsClient({ baseUrl: origin });
  const cases = [
    ['listVaults', () => c.listVaults(), '/vaults'],
    ['listFeaturedVaults', () => c.listFeaturedVaults(), '/vaults/featured'],
    ['getVault', () => c.getVault('eip155:1', '0xAbC'), '/vaults/eip155%3A1/0xAbC'],
    ['getVaultAnalytics (no params)', () => c.getVaultAnalytics('1', '0xa'), '/vaults/1/0xa/analytics'],
    [
      'getVaultAnalytics (range + repeated metric)',
      () => c.getVaultAnalytics('1', '0xa', { since: '2026-01-01', until: '2026-02-01', metric: ['tvl', 'apy'] }),
      '/vaults/1/0xa/analytics?since=2026-01-01&until=2026-02-01&metric=tvl&metric=apy',
    ],
    [
      'getVaultAnalytics (single metric, days, undefined skipped)',
      () => c.getVaultAnalytics('1', '0xa', { metric: 'tvl', days: 7, since: undefined }),
      '/vaults/1/0xa/analytics?metric=tvl&days=7',
    ],
    ['getVaultRiskIndicators', () => c.getVaultRiskIndicators('1', '0xa'), '/vaults/1/0xa/risk-indicators'],
    ['getUserVaultBalance', () => c.getUserVaultBalance('1', '0xa', '0xW'), '/vaults/1/0xa/users/0xW/balance'],
    ['getUserVaultActivity', () => c.getUserVaultActivity('1', '0xa', '0xW'), '/vaults/1/0xa/users/0xW/activity'],
    ['getUserPositions', () => c.getUserPositions('0xW'), '/users/0xW/positions'],
    ['listBlockchains', () => c.listBlockchains(), '/blockchains'],
    ['getRelatedVaults', () => c.getRelatedVaults('1', '0xa'), '/vaults/related/1/0xa'],
    ['getProtocolInsights (no marketId)', () => c.getProtocolInsights('ethereum', 'aave'), '/vaults/protocol/ethereum/aave'],
    ['getProtocolInsights (empty marketId)', () => c.getProtocolInsights('ethereum', 'aave', ''), '/vaults/protocol/ethereum/aave'],
    [
      'getProtocolInsights (marketId)',
      () => c.getProtocolInsights('ethereum', 'aave', 'USDC/core'),
      '/vaults/protocol/ethereum/aave/USDC%2Fcore',
    ],
    ['getVaultMainInsights', () => c.getVaultMainInsights('1', '0xa'), '/vaults/1/0xa/main-insights'],
    ['getStrategyMetrics (no params)', () => c.getStrategyMetrics('p-1'), '/strategies/positions/p-1/metric'],
    [
      'getStrategyMetrics (params)',
      () => c.getStrategyMetrics('p-1', { vaultAddress: '0xa', vaultChainId: 'eip155:1', since: 's', until: 'u', refresh: true }),
      '/strategies/positions/p-1/metric?vaultAddress=0xa&vaultChainId=eip155%3A1&since=s&until=u&refresh=true',
    ],
    ['getProtocolTvl', () => c.getProtocolTvl('aave v3'), '/protocols/aave%20v3/tvl'],
    ['getPulseMetadata', () => c.getPulseMetadata(), '/pulse/metadata'],
    ['getPulseNotifications (no query)', () => c.getPulseNotifications(), '/pulse/notifications'],
    [
      'getPulseNotifications (repeated arrays, paging)',
      () => c.getPulseNotifications({
        vaultAddresses: ['0xa', '0xb'],
        vaultChainIds: ['eip155:1', 'eip155:8453'],
        limit: 20,
        last_evaluated_key: '{"k":1}',
      }),
      '/pulse/notifications?vaultAddresses=0xa&vaultAddresses=0xb&vaultChainIds=eip155%3A1&vaultChainIds=eip155%3A8453&limit=20&last_evaluated_key=%7B%22k%22%3A1%7D',
    ],
    ['getPulseNotifications (empty array)', () => c.getPulseNotifications({ vaultAddresses: [] }), '/pulse/notifications'],
  ];
  for (const [name, call, expected] of cases) {
    await t.test(name, async () => {
      requests = [];
      assert.deepEqual(await call(), { ok: true });
      assert.equal(requests.length, 1);
      assert.equal(last().method, 'GET');
      assert.equal(last().url, expected);
    });
  }
});

test('path segments are percent-encoded so they cannot add segments or a query', async () => {
  const c = new YieldsClient({ baseUrl: origin });
  await c.getUserVaultBalance('../x', 'a?b=1', 'w#frag');
  assert.equal(last().url, '/vaults/..%2Fx/a%3Fb%3D1/users/w%23frag/balance');
  await c.getProtocolInsights('a b', 'p&q', '%2F');
  assert.equal(last().url, '/vaults/protocol/a%20b/p%26q/%252F');
});

test('GET headers: accept + default UA, x-api-key only when configured', async () => {
  await new YieldsClient({ baseUrl: origin }).listVaults();
  let h = last().headers;
  assert.equal(h.accept, 'application/json');
  assert.equal(h['user-agent'], DEFAULT_USER_AGENT);
  assert.equal('x-api-key' in h, false);
  assert.equal('content-type' in h, false);

  await new YieldsClient({ baseUrl: origin, apiKey: 'k-123', userAgent: 'my-integration/1.0' }).listVaults();
  h = last().headers;
  assert.equal(h['x-api-key'], 'k-123');
  assert.equal(h['user-agent'], 'my-integration/1.0');

  await new YieldsClient({ baseUrl: origin, apiKey: '' }).listVaults();
  assert.equal('x-api-key' in last().headers, false);
});

test('DEFAULT_USER_AGENT embeds CLIENT_VERSION in the compatible-bot format', () => {
  assert.equal(CLIENT_VERSION, '0.0.0-dev');
  assert.equal(DEFAULT_USER_AGENT, 'Mozilla/5.0 (compatible; sentora-yields-client/0.0.0-dev; +https://sentora.com)');
});

test('getStrategyAllocationDistribution POSTs a JSON body', async () => {
  handler = json(200, { metric: [], lastMetricDate: null });
  const payload = { positions: ['p1', 'p2'], vaultAddress: '0xa', vaultChainId: 'eip155:1', since: null, refresh: false };
  const c = new YieldsClient({ baseUrl: origin, apiKey: 'k' });
  assert.deepEqual(await c.getStrategyAllocationDistribution(payload), { metric: [], lastMetricDate: null });
  const r = last();
  assert.equal(r.method, 'POST');
  assert.equal(r.url, '/strategies/positions/allocation-distribution/chart');
  assert.equal(r.headers['content-type'], 'application/json');
  assert.equal(r.headers.accept, 'application/json');
  assert.equal(r.headers['x-api-key'], 'k');
  assert.equal(r.headers['user-agent'], DEFAULT_USER_AGENT);
  assert.deepEqual(JSON.parse(r.body), payload);

  await new YieldsClient({ baseUrl: origin }).getStrategyAllocationDistribution({ positions: [] });
  assert.equal('x-api-key' in last().headers, false);
});

test('POST errors map to YieldsApiError like GET', async () => {
  handler = json(422, { message: 'positions required' });
  await assert.rejects(
    new YieldsClient({ baseUrl: origin }).getStrategyAllocationDistribution({ positions: [] }),
    (e) => e instanceof YieldsApiError && e.status === 422
      && e.path === '/strategies/positions/allocation-distribution/chart' && e.message === 'positions required',
  );
});

test('constructor: base URL handling', async () => {
  await new YieldsClient({ baseUrl: `${origin}///` }).listVaults();
  assert.equal(last().url, '/vaults');

  await new YieldsClient({ baseUrl: `${origin}/api/v1/` }).getVault('1', '0xa');
  assert.equal(last().url, '/api/v1/vaults/1/0xa');

  assert.doesNotThrow(() => new YieldsClient());
  assert.doesNotThrow(() => new YieldsClient({ baseUrl: 'https://staging.example.com/' }));
  assert.doesNotThrow(() => new YieldsClient({ baseUrl: 'http://localhost:3000' }));
  assert.doesNotThrow(() => new YieldsClient({ baseUrl: 'http://[::1]:3000' }));
  assert.equal(DEFAULT_BASE_URL, 'https://services.vaults.sentora.com');
});

test('constructor: plain http is allowed on loopback even with an api key', async () => {
  const c = new YieldsClient({ baseUrl: origin, apiKey: 'k' });
  await c.listVaults();
  assert.equal(last().headers['x-api-key'], 'k');
});

test('constructor: rejects invalid and non-loopback http base URLs', () => {
  assert.throws(() => new YieldsClient({ baseUrl: 'not a url' }), /baseUrl is not a valid URL/);
  assert.throws(() => new YieldsClient({ baseUrl: '' }), /baseUrl is not a valid URL/);
  const insecure = /baseUrl must be https \(plain http is allowed only for loopback hosts\)/;
  assert.throws(() => new YieldsClient({ baseUrl: 'http://example.com' }), insecure);
  assert.throws(() => new YieldsClient({ baseUrl: 'http://localhost.evil.com' }), insecure);
  assert.throws(() => new YieldsClient({ baseUrl: 'http://127.0.0.1.nip.io' }), insecure);
  assert.throws(() => new YieldsClient({ baseUrl: 'ftp://localhost' }), insecure);
  assert.throws(() => new YieldsClient({ baseUrl: 'ws://localhost' }), insecure);
  assert.throws(
    () => new YieldsClient({ baseUrl: 'http://user:secret@example.com/path' }),
    (e) => e.message.includes("got origin 'http://example.com'") && !e.message.includes('secret'),
  );
});

test('fetchImpl override receives the URL and init', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response('[1]', { status: 200 });
  };
  const c = new YieldsClient({ baseUrl: 'https://api.example.com', apiKey: 'k', fetchImpl });
  assert.deepEqual(await c.listBlockchains(), [1]);
  assert.equal(calls[0].url, 'https://api.example.com/blockchains');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers['x-api-key'], 'k');
  assert.equal(calls[0].init.signal, undefined);
});

test('errors: non-2xx with JSON message', async () => {
  handler = json(404, { hasError: true, message: 'Vault not found', status: 404 });
  const err = await new YieldsClient({ baseUrl: origin }).getVault('1', '0xa').catch((e) => e);
  assert.ok(err instanceof YieldsApiError);
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'YieldsApiError');
  assert.equal(err.status, 404);
  assert.equal(err.path, '/vaults/1/0xa');
  assert.equal(err.message, 'Vault not found');
});

test('errors: JSON body without message falls back to status + path', async () => {
  handler = json(500, { hasError: true });
  await assert.rejects(new YieldsClient({ baseUrl: origin }).listVaults(), {
    name: 'YieldsApiError', status: 500, path: '/vaults', message: 'HTTP 500 on /vaults',
  });
  handler = json(503, '42');
  await assert.rejects(new YieldsClient({ baseUrl: origin }).listVaults(), { message: 'HTTP 503 on /vaults' });
});

test('errors: JSON string body is used as the message', async () => {
  handler = json(400, '"bad chain"');
  await assert.rejects(new YieldsClient({ baseUrl: origin }).listVaults(), { status: 400, message: 'bad chain' });
});

test('errors: JSON null error body maps to YieldsApiError', async () => {
  handler = json(500, 'null');
  await assert.rejects(new YieldsClient({ baseUrl: origin }).listVaults(), { name: 'YieldsApiError', message: 'HTTP 500 on /vaults' });
});

test('errors: non-string JSON message maps to YieldsApiError', async () => {
  handler = json(500, { message: 123 });
  await assert.rejects(new YieldsClient({ baseUrl: origin }).listVaults(), { name: 'YieldsApiError', status: 500 });
});

test('errors: non-JSON error body is used raw; empty body falls back', async () => {
  handler = (req, res) => { res.writeHead(403, { 'content-type': 'text/html' }); res.end('<html>Forbidden</html>'); };
  await assert.rejects(new YieldsClient({ baseUrl: origin }).listVaults(), { status: 403, message: '<html>Forbidden</html>' });

  handler = (req, res) => { res.writeHead(502); res.end(); };
  await assert.rejects(new YieldsClient({ baseUrl: origin }).listVaults(), { status: 502, message: 'HTTP 502 on /vaults' });

  handler = (req, res) => { res.writeHead(502); res.end(' \n\t '); };
  await assert.rejects(new YieldsClient({ baseUrl: origin }).listVaults(), { message: 'HTTP 502 on /vaults' });
});

test('errors: upstream message is flattened and capped', async () => {
  handler = json(500, { message: 'line1\r\n\x1b[31mline2\x7f  end' });
  await assert.rejects(new YieldsClient({ baseUrl: origin }).listVaults(), { message: 'line1 [31mline2 end' });

  handler = (req, res) => { res.writeHead(500); res.end('x'.repeat(1000)); };
  const err = await new YieldsClient({ baseUrl: origin }).listVaults().catch((e) => e);
  assert.equal(err.message, `${'x'.repeat(300)}… [truncated]`);

  handler = (req, res) => { res.writeHead(500); res.end('y'.repeat(300)); };
  await assert.rejects(new YieldsClient({ baseUrl: origin }).listVaults(), { message: 'y'.repeat(300) });
});

test('errors: non-JSON success body throws YieldsApiError with the success status', async () => {
  handler = (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>maintenance</html>'); };
  await assert.rejects(new YieldsClient({ baseUrl: origin }).listVaults(), {
    name: 'YieldsApiError', status: 200, path: '/vaults', message: 'expected a JSON body, got: <html>maintenance</html>',
  });

  handler = (req, res) => { res.writeHead(204); res.end(); };
  await assert.rejects(new YieldsClient({ baseUrl: origin }).listVaults(), {
    status: 204, message: 'expected a JSON body, got:',
  });
});

test('errors: JSON null success body is returned as null', async () => {
  handler = json(200, 'null');
  assert.equal(await new YieldsClient({ baseUrl: origin }).getPulseMetadata(), null);
});

test('errors: network failure propagates the fetch TypeError', async () => {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const err = await new YieldsClient({ baseUrl: `http://127.0.0.1:${port}` }).listVaults().catch((e) => e);
  assert.ok(err instanceof TypeError);
  assert.equal(err instanceof YieldsApiError, false);
});

test('redirects are followed without an api key', async () => {
  handler = (req, res) => {
    if (req.url === '/vaults') {
      res.writeHead(302, { location: '/moved' });
      res.end();
    } else {
      json(200, [{ moved: true }])(req, res);
    }
  };
  assert.deepEqual(await new YieldsClient({ baseUrl: origin }).listVaults(), [{ moved: true }]);
  assert.deepEqual(requests.map((r) => r.url), ['/vaults', '/moved']);
});

test('redirects are refused when an api key is set', async () => {
  handler = (req, res) => {
    res.writeHead(307, { location: '/moved' });
    res.end();
  };
  const c = new YieldsClient({ baseUrl: origin, apiKey: 'k' });
  await assert.rejects(c.listVaults(), TypeError);
  await assert.rejects(c.getStrategyAllocationDistribution({ positions: [] }), TypeError);
  assert.deepEqual(requests.map((r) => r.url), ['/vaults', '/strategies/positions/allocation-distribution/chart']);
});

test('AbortSignal cancels GET and POST', { timeout: 5_000 }, async () => {
  const c = new YieldsClient({ baseUrl: origin });

  await assert.rejects(c.listVaults({ signal: AbortSignal.abort() }), { name: 'AbortError' });
  await assert.rejects(c.getStrategyAllocationDistribution({ positions: [] }, { signal: AbortSignal.abort() }), {
    name: 'AbortError',
  });

  let pending;
  const arrived = new Promise((resolve) => { handler = (req, res) => { pending = res; resolve(); }; });
  const ac = new AbortController();
  const p = c.getVaultAnalytics('1', '0xa', { days: 1 }, { signal: ac.signal });
  await arrived;
  ac.abort();
  await assert.rejects(p, { name: 'AbortError' });
  pending.destroy();
});

test('toCaip2ChainId edge cases', () => {
  assert.equal(toCaip2ChainId('SOLANA'), 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
  assert.equal(toCaip2ChainId('STELLAR'), 'stellar:pubnet');
  assert.equal(toCaip2ChainId('0'), 'eip155:0');
  assert.equal(toCaip2ChainId('8453'), 'eip155:8453');
  assert.equal(toCaip2ChainId('cosmos:cosmoshub-4'), 'cosmos:cosmoshub-4');
  assert.equal(toCaip2ChainId('eip155:abc'), 'eip155:abc');
  assert.equal(toCaip2ChainId('EIP155:1'), 'EIP155:1');
  assert.equal(toCaip2ChainId(' 1 '), ' 1 ');
  assert.equal(toCaip2ChainId(' solana'), ' solana');
  assert.equal(toCaip2ChainId('-1'), '-1');
  assert.equal(toCaip2ChainId('1.5'), '1.5');
  assert.equal(toCaip2ChainId('ethereum'), 'ethereum');
  assert.equal(toCaip2ChainId(''), '');
  assert.equal(toCaip2ChainId('constructor'), 'constructor');
  assert.equal(toCaip2ChainId('__proto__'), '__proto__');
  assert.equal(toCaip2ChainId('toString'), 'toString');
});

test('evmChainId edge cases', () => {
  assert.equal(evmChainId('0'), undefined);
  assert.equal(evmChainId('eip155:0'), undefined);
  assert.equal(evmChainId('eip155:8453'), 8453);
  assert.equal(evmChainId('8453'), 8453);
  assert.equal(evmChainId('01'), 1);
  assert.equal(evmChainId('eip155:abc'), undefined);
  assert.equal(evmChainId('EIP155:1'), undefined);
  assert.equal(evmChainId(' 1 '), undefined);
  assert.equal(evmChainId('-1'), undefined);
  assert.equal(evmChainId('eip155:-1'), undefined);
  assert.equal(evmChainId('1e3'), undefined);
  assert.equal(evmChainId('ethereum'), undefined);
  assert.equal(evmChainId('cosmos:cosmoshub-4'), undefined);
  assert.equal(evmChainId('SOLANA'), undefined);
  assert.equal(evmChainId(''), undefined);
  assert.equal(evmChainId('9007199254740991'), 9007199254740991);
  assert.equal(evmChainId('9007199254740992'), undefined);
  assert.equal(evmChainId('99999999999999999999999999999999'), undefined);
});
