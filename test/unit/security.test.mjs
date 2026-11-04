/**
 * Security-behavior tests: API-key handling, URL path encoding, output and
 * error sanitization, flag bounds, address checksums, error taxonomy, and
 * boring queue discovery trust. No live network — spawned CLI calls only
 * ever target closed loopback ports.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CallExecutionError, ExecutionRevertedError, HttpRequestError, getAbiItem, getAddress, toFunctionSelector, zeroHash } from 'viem';

import { YieldsClient, YieldsApiError } from '../../packages/yields-client/src/index.ts';
import { escapeControl } from '../../packages/vaults-cli/src/output.ts';
import { toCliError, sanitizeErrorMessage } from '../../packages/vaults-cli/src/errors.ts';
import { summarizeSeries } from '../../packages/vaults-cli/src/families/yields.ts';
import { pendingWithdrawalsReport } from '../../packages/vaults-cli/src/families/upshift-financial.ts';
import { withdrawalRequestsFromActivity } from '../../packages/vaults-upshift-financial/src/core.ts';
import { redactUrl } from '../../packages/vaults-cli/src/helpers.ts';
import { discoverConfig } from '../../packages/vaults-boring/src/discover.ts';
import { boringQueueAbi, QUEUE_REQUEST_WITHDRAW_SELECTOR } from '../../packages/vaults-boring/src/abi.ts';
import { planDeposit as boringPlanDeposit, planRequestWithdraw } from '../../packages/vaults-boring/src/plan.ts';
import { isQueueDeprecated } from '../../packages/vaults-boring/src/core.ts';
import { planDeposit as morphoPlanDeposit } from '../../packages/vaults-morpho/src/plan.ts';
import { fakePc, revertError } from './fakes.mjs';

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const ESC = String.fromCharCode(27);
const BS = String.fromCharCode(92);

const CLI_BUNDLE = fileURLToPath(new URL('../../packages/vaults-cli/dist/cli.mjs', import.meta.url));
const CLI_SRC = fileURLToPath(new URL('../../packages/vaults-cli/src/cli.ts', import.meta.url));
const ARGV = process.env.NODE_V8_COVERAGE ? ['--import', 'tsx', CLI_SRC] : [CLI_BUNDLE];

const DEAD = '0x000000000000000000000000000000000000dEaD';
const RPC_CLOSED = ['--rpc-url', 'http://127.0.0.1:1'];

/** raw spawn with RPC and yields env stripped for determinism */
function raw(args, envOverride = {}) {
  const env = {
    ...process.env,
    VAULTS_RPC_URL: '', SENTORA_RPC_URL: '', ETH_RPC_URL: '',
    YIELDS_API_KEY: '', SENTORA_API_KEY: '', YIELDS_BASE_URL: '', SENTORA_API_URL: '',
    ...envOverride,
  };
  for (const k of Object.keys(env)) if (env[k] === '') delete env[k];
  const res = spawnSync(process.execPath, [...ARGV, ...args], { encoding: 'utf8', env, timeout: 60_000 });
  let json, error;
  try { json = JSON.parse(res.stdout); } catch { /* not JSON */ }
  try { error = JSON.parse(res.stderr)?.error; } catch { /* not JSON */ }
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, json, error };
}

// ---------- API-key handling ----------

test('the API key cannot be passed as a CLI flag', () => {
  const r = raw(['yields', 'get', '--chain-id', '1', '--address', DEAD, '--api-key', 'k']);
  assert.equal(r.code, 2);
  assert.match(r.error.message, /Unknown flag/);
});

test('plain-http --base-url is rejected off-loopback', () => {
  const r = raw(['yields', 'get', '--chain-id', '1', '--address', DEAD, '--base-url', 'http://evil.example']);
  assert.equal(r.code, 2);
  assert.match(r.error.message, /https/);
});

test('the env API key is refused to a non-default --base-url origin, without echoing the key', () => {
  const r = raw(
    ['yields', 'get', '--chain-id', '1', '--address', DEAD, '--base-url', 'https://evil.example'],
    { YIELDS_API_KEY: 'sekret-key-value' },
  );
  assert.equal(r.code, 2);
  assert.match(r.error.message, /Refusing to send/);
  assert.match(r.error.hint, /YIELDS_BASE_URL/);
  assert.ok(!r.stderr.includes('sekret-key-value'));
  assert.ok(!r.stdout.includes('sekret-key-value'));
});

test('a --base-url matching the env-configured origin passes the origin check', () => {
  const r = raw(
    ['yields', 'get', '--chain-id', '1', '--address', DEAD, '--base-url', 'http://127.0.0.1:9'],
    { YIELDS_API_KEY: 'k', YIELDS_BASE_URL: 'http://127.0.0.1:9' },
  );
  // origin check passed; the request then fails on the closed port, which is not a USAGE error
  assert.notEqual(r.code, 2);
  assert.match(r.error.message, /fetch failed/);
});

test('YieldsClient: key attaches on an allowed origin, redirects are refused, path segments are encoded', async () => {
  let captured;
  const client = new YieldsClient({
    baseUrl: 'https://api.example.com',
    apiKey: 'k',
    fetchImpl: async (url, init) => {
      captured = { url: String(url), init };
      return new Response('{}', { status: 200 });
    },
  });
  await client.getVault('1/../admin', '0xabc?x=1');
  assert.ok(captured.url.includes('/vaults/1%2F..%2Fadmin/0xabc%3Fx%3D1'), captured.url);
  assert.equal(captured.init.redirect, 'error');
  assert.equal(captured.init.headers['x-api-key'], 'k');
});

test('YieldsClient refuses plain-http base URLs off-loopback', () => {
  assert.throws(() => new YieldsClient({ baseUrl: 'http://api.example.com' }), /https/);
  assert.throws(() => new YieldsClient({ baseUrl: 'http://api.example.com', apiKey: 'k' }), /https/);
  new YieldsClient({ baseUrl: 'http://127.0.0.1:8080' });
  new YieldsClient({ baseUrl: 'http://localhost:8080' });
  new YieldsClient({ baseUrl: 'https://api.example.com' });
});

test('YieldsClient accepts an apiKey on http loopback (local dev against an auth-requiring service)', () => {
  new YieldsClient({ baseUrl: 'http://127.0.0.1:8080', apiKey: 'k' });
  new YieldsClient({ baseUrl: 'http://localhost:8080', apiKey: 'k' });
});

test('YieldsClient: POST attaches the key, refuses redirects, and sends a JSON body', async () => {
  let captured;
  const client = new YieldsClient({
    baseUrl: 'https://api.example.com',
    apiKey: 'k',
    fetchImpl: async (url, init) => {
      captured = { url: String(url), init };
      return new Response('{}', { status: 200 });
    },
  });
  await client.getStrategyAllocationDistribution({ positions: ['p1'] });
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.redirect, 'error');
  assert.equal(captured.init.headers['x-api-key'], 'k');
  assert.deepEqual(JSON.parse(captured.init.body).positions, ['p1']);
});

test('YieldsClient follows redirects only when no key is configured', async () => {
  let captured;
  const client = new YieldsClient({
    baseUrl: 'https://api.example.com',
    fetchImpl: async (url, init) => {
      captured = init;
      return new Response('[]', { status: 200 });
    },
  });
  await client.listFeaturedVaults();
  assert.equal(captured.redirect, 'follow');
  assert.equal(captured.headers['x-api-key'], undefined);
});

test('a 2xx non-JSON body raises a sanitized YieldsApiError', async () => {
  const client = new YieldsClient({
    baseUrl: 'https://api.example.com',
    fetchImpl: async () => new Response(`<html>${ESC}[31mWAF${NL}page</html>`, { status: 200 }),
  });
  await assert.rejects(client.listFeaturedVaults(), (e) => {
    assert.equal(e.name, 'YieldsApiError');
    assert.match(e.message, /JSON body/);
    assert.ok(!e.message.includes(ESC) && !e.message.includes(NL));
    return true;
  });
});

test('upshift_evm pending-withdrawals applies the same yields origin checks before any network call', () => {
  const base = ['upshift_evm', 'pending-withdrawals', '--vault', DEAD, '--owner', DEAD, ...RPC_CLOSED];
  const http = raw([...base, '--base-url', 'http://evil.example']);
  assert.equal(http.code, 2);
  assert.match(http.error.message, /https/);

  const foreign = raw([...base, '--base-url', 'https://evil.example'], { YIELDS_API_KEY: 'sekret-key-value' });
  assert.equal(foreign.code, 2);
  assert.match(foreign.error.message, /Refusing to send/);
  assert.ok(!foreign.stderr.includes('sekret-key-value'));
});

test('withdrawalRequestsFromActivity keeps WITHDRAW_REQUEST rows and rejects malformed API data', () => {
  const row = (over) => ({ type: 'WITHDRAW_REQUEST', timestamp: '2026-10-22T12:18:23.000Z', blockNumber: 26248104, id: 'x', ...over });
  assert.deepEqual(withdrawalRequestsFromActivity([row({}), row({ type: 'DEPOSIT' }), null]), [
    { requestedAt: BigInt(Date.UTC(2026, 9, 22, 12, 18, 23) / 1000), blockNumber: 26248104n },
  ]);
  for (const blockNumber of [-1, 1.5, '26248104', null]) {
    assert.throws(() => withdrawalRequestsFromActivity([row({ blockNumber })]), (e) => e.name === 'InvalidActivityError' && /blockNumber/.test(e.message));
  }
  assert.throws(() => withdrawalRequestsFromActivity({ items: [] }), (e) => e.name === 'InvalidActivityError');
  assert.throws(
    () => withdrawalRequestsFromActivity([row({ timestamp: `not a date${ESC}[2J`.padEnd(200, 'x') })]),
    (e) => e.name === 'InvalidActivityError' && !e.message.includes(ESC) && e.message.length < 200,
  );
});

test('pending-withdrawals maps malformed API data to UPSTREAM_API and names the failed historic read', async () => {
  await assert.rejects(pendingWithdrawalsReport({}, DEAD, DEAD, { items: [] }), (e) => e.code === 'UPSTREAM_API');

  const pc = {
    getBlock: async () => ({ timestamp: 0n }),
    readContract: async ({ functionName }) => {
      if (functionName === 'getWithdrawalEpoch') throw new Error('header not found');
      if (functionName === 'lagDuration') return 259200n;
      if (functionName === 'getBurnableAmountByReceiver') return 0n;
      return [0n, 0n];
    },
  };
  const report = await pendingWithdrawalsReport(pc, DEAD, DEAD, [
    { type: 'WITHDRAW_REQUEST', timestamp: '2026-10-22T12:18:23Z', blockNumber: 1 },
    { type: 'WITHDRAW_REQUEST', timestamp: '2026-10-22T13:18:23Z', blockNumber: 5 },
  ]);
  assert.equal(report.requestsByOwner, 2);
  assert.match(report.warnings[0], /at block\(s\) 1, 5 \(header not found\)/);

  const many = await pendingWithdrawalsReport(pc, DEAD, DEAD, Array.from({ length: 12 }, (_, i) => (
    { type: 'WITHDRAW_REQUEST', timestamp: '2026-10-22T12:18:23Z', blockNumber: i + 1 }
  )));
  assert.match(many.warnings[0], /at block\(s\) 1, 2, 3, 4, 5 and 7 more \(header not found\)/);
});

// ---------- chain-id validation ----------

test('--chain-id with path separators is a USAGE error before any request', () => {
  for (const bad of ['1/../admin', '1?x=', '1#frag', 'a/b']) {
    const r = raw(['yields', 'get', '--chain-id', bad, '--address', DEAD, '--base-url', 'http://127.0.0.1:9']);
    assert.equal(r.code, 2, `expected USAGE for chain-id '${bad}'`);
    assert.match(r.error.message, /chain-id/);
  }
});

test('--chain-id accepts CAIP-2 ids and reaches the network', () => {
  const r = raw(['yields', 'get', '--chain-id', 'eip155:1', '--address', DEAD, '--base-url', 'http://127.0.0.1:9', '--timeout', '3000']);
  assert.equal(r.code, 4, r.stderr);
  assert.equal(r.error.code, 'RPC_ERROR');
});

test('--address/--wallet: only 0x, Solana base58 or Stellar ids reach the URL path', () => {
  const get = (address) => raw(['yields', 'get', '--chain-id', 'eip155:1', '--address', address, '--base-url', 'http://127.0.0.1:9', '--timeout', '3000']);
  for (const bad of ['not/an/address', '../admin', 'A2wsx?x=1', 'abcdefABCDEF1234567891234567891234567891', 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV']) {
    const r = get(bad);
    assert.equal(r.code, 2, `expected USAGE for --address '${bad}'`);
  }
  assert.match(get('abcdefABCDEF1234567891234567891234567891').error.message, /0x-prefixed/);
  assert.match(get('CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV').error.message, /Solana base58 address or a Stellar/);
  assert.equal(get('A2wsxhA7pF4B2UKVfXocb6TAAP9ipfPJam6oMKgDE5BK').code, 4);
  const wallet = raw(['yields', 'positions', '--wallet', 'G/../x', '--base-url', 'http://127.0.0.1:9']);
  assert.equal(wallet.code, 2);
});

test('snapshot validates --base-url and the api-key origin before any request', () => {
  const common = ['snapshot', '--vault', DEAD, '--rpc-url', 'http://127.0.0.1:9', '--timeout', '3000'];
  const plain = raw([...common, '--base-url', 'http://evil.example']);
  assert.equal(plain.code, 2, plain.stderr);
  assert.match(plain.error.message, /https/);
  const keyed = raw([...common, '--base-url', 'https://evil.example'], { YIELDS_API_KEY: 'k' });
  assert.equal(keyed.code, 2, keyed.stderr);
  assert.match(keyed.error.message, /Refusing to send the configured API key/);
});

// ---------- output & error sanitization ----------

test('escapeControl neutralizes newlines and ANSI escapes in text-mode values', () => {
  assert.equal(escapeControl(`USDC${NL}steps[1].to=0xEVIL`), `USDC${BS}nsteps[1].to=0xEVIL`);
  assert.equal(escapeControl(`a${CR}b`), `a${BS}rb`);
  assert.equal(escapeControl(`red${ESC}[31m`), `red${BS}x1b[31m`);
  assert.equal(escapeControl('plain value 123'), 'plain value 123');
});

test('toCliError collapses control chars and truncates runaway messages', () => {
  const e = toCliError(new Error('x'.repeat(3000)));
  assert.equal(e.code, 'UNEXPECTED');
  assert.ok(e.message.length < 600, `message still ${e.message.length} chars`);
  assert.match(e.message, /truncated/);
  assert.equal(sanitizeErrorMessage(`a${NL}${NL}${ESC}b`), 'a b');
});

test('YieldsApiError sanitizes and caps raw upstream bodies', () => {
  const big = new YieldsApiError(502, '/x', 'B'.repeat(5000));
  assert.ok(big.message.length < 330, `message still ${big.message.length} chars`);
  assert.match(big.message, /truncated/);
  const sneaky = new YieldsApiError(500, '/x', `bad${NL}${ESC}[31mline`);
  assert.ok(!sneaky.message.includes(NL));
  assert.ok(!sneaky.message.includes(ESC));
});

// ---------- flag bounds ----------

test('--slippage-bps 10000 is rejected as USAGE before any network use', () => {
  const r = raw(['boring', 'plan-deposit', '--vault', DEAD, '--asset', DEAD, '--amount', '1', '--owner', DEAD, '--slippage-bps', '10000', ...RPC_CLOSED]);
  assert.equal(r.code, 2);
  assert.match(r.error.message, /slippage-bps/);
});

test('--seconds-to-deadline above uint24 is rejected as USAGE', () => {
  const r = raw(['boring', 'plan-withdraw', '--vault', DEAD, '--asset-out', DEAD, '--shares', '1', '--owner', DEAD, '--seconds-to-deadline', '16777216', ...RPC_CLOSED]);
  assert.equal(r.code, 2);
  assert.match(r.error.message, /seconds-to-deadline/);
});

test('boring planners validate bounds before touching the RPC', async () => {
  const cfg = { vault: DEAD, teller: DEAD, accountant: DEAD, queue: DEAD, rolesAuthority: DEAD, chainId: 1 };
  const noPc = {};
  await assert.rejects(boringPlanDeposit(noPc, cfg, { asset: DEAD, amount: 1n, owner: DEAD, slippageBps: 10_000 }), /slippageBps/);
  await assert.rejects(planRequestWithdraw(noPc, cfg, { assetOut: DEAD, shares: 1n, owner: DEAD, secondsToDeadline: 16_777_216 }), /uint24/);
  await assert.rejects(planRequestWithdraw(noPc, cfg, { assetOut: DEAD, shares: 1n, owner: DEAD, discountBps: 65_536 }), /uint16/);
});

// ---------- address checksums ----------

test('a mixed-case address with a bad checksum is rejected; lowercase is accepted', () => {
  const good = getAddress(DEAD.toLowerCase());
  const letterIdx = [...good].findIndex((c, i) => i >= 2 && /[a-fA-F]/.test(c));
  const flipped = good[letterIdx] === good[letterIdx].toLowerCase() ? good[letterIdx].toUpperCase() : good[letterIdx].toLowerCase();
  const bad = good.slice(0, letterIdx) + flipped + good.slice(letterIdx + 1);

  const rejected = raw(['morpho', 'meta', '--vault', bad, ...RPC_CLOSED]);
  assert.equal(rejected.code, 2);
  assert.match(rejected.error.message, /checksum/);

  const lower = raw(['morpho', 'meta', '--vault', DEAD.toLowerCase(), ...RPC_CLOSED]);
  assert.equal(lower.code, 4, `lowercase address must pass validation and fail as RPC_ERROR, got ${lower.code}: ${lower.stderr}`);
});

// ---------- error taxonomy ----------

test('detect against an unreachable RPC exits 4 (retryable RPC_ERROR), not 3 (NOT_FOUND)', () => {
  const r = raw(['detect', '--vault', DEAD, ...RPC_CLOSED]);
  assert.equal(r.code, 4, r.stderr);
  assert.equal(r.error.code, 'RPC_ERROR');
  assert.equal(r.error.retryable, true);
});

// ---------- RPC URL redaction ----------

test('redactUrl masks path-embedded provider keys', () => {
  const out = redactUrl('https://eth-mainnet.g.alchemy.com/v2/SECRET123');
  assert.ok(!out.includes('SECRET123'));
  assert.equal(out, 'https://eth-mainnet.g.alchemy.com/…');
  assert.equal(redactUrl('not a url'), '<invalid-url>');
});

test('--verbose never echoes a key-bearing RPC URL', () => {
  const r = raw(['morpho', 'meta', '--vault', DEAD, '--verbose', '--rpc-url', 'http://127.0.0.1:1/v2/SUPERSECRETKEY123']);
  assert.ok(!r.stderr.includes('SUPERSECRETKEY123'), r.stderr);
  assert.ok(!r.stdout.includes('SUPERSECRETKEY123'));
});

test('npm run verify never echoes a key-bearing RPC URL when the RPC fails', () => {
  const script = fileURLToPath(new URL('../../scripts/verify.mjs', import.meta.url));
  const res = spawnSync(process.execPath, [script], {
    encoding: 'utf8', timeout: 60_000, env: { ...process.env, ETH_RPC_URL: 'http://127.0.0.1:1/v2/SUPERSECRETKEY123' },
  });
  assert.equal(res.status, 1, res.stderr);
  assert.ok(!res.stderr.includes('SUPERSECRETKEY123'), res.stderr);
  assert.ok(!res.stdout.includes('SUPERSECRETKEY123'), res.stdout);
  assert.match(res.stderr, /Cannot read from the RPC at http:\/\/127\.0\.0\.1:1\/…/);
});

// ---------- analytics summary ----------

test('summarizeSeries handles very large API-controlled series', () => {
  const series = Array.from({ length: 200_000 }, (_, i) => [i, i % 1000]);
  const s = summarizeSeries(series);
  assert.equal(s.points, 200_000);
  assert.equal(s.min, 0);
  assert.equal(s.max, 999);
  assert.equal(s.from, 0);
  assert.equal(s.to, 199_999);
});

// ---------- boring queue discovery ----------

const VAULT = '0x' + '11'.repeat(20);
const AUTH = '0x' + '22'.repeat(20);
const TELLER = '0x' + '33'.repeat(20);
const ACC = '0x' + '44'.repeat(20);
const QUEUE = '0x' + '55'.repeat(20);
const OTHER = '0x' + '66'.repeat(20);
const ROLE_1 = '0x' + '00'.repeat(31) + '02';

/**
 * linked: queues whose boringVault() is VAULT; capability: per-queue
 * requestOnChainWithdraw state on the vault's authority
 * ('public' | 'role' | 'none' | 'throws'); scanTargets: authority event targets, oldest first.
 */
function discoveryPc({ linked = [QUEUE], capability = {}, scanTargets = [], queueAuthority = AUTH } = {}) {
  const cap = (queue) => {
    const c = capability[queue] ?? 'public';
    if (c === 'throws') throw new Error('rpc down');
    return c;
  };
  return {
    getChainId: async () => 1,
    getLogs: async ({ address, event }) => {
      if (address !== AUTH) throw new Error(`unexpected getLogs on ${address}`);
      return event.name === 'PublicCapabilityUpdated' ? scanTargets.map((target) => ({ args: { target } })) : [];
    },
    readContract: async ({ address, functionName, args }) => {
      const at = address.toLowerCase();
      if (at === VAULT && functionName === 'authority') return AUTH;
      if (at === VAULT && functionName === 'hook') return TELLER;
      if (at === TELLER && functionName === 'vault') return VAULT;
      if (at === TELLER && functionName === 'accountant') return ACC;
      if (functionName === 'authority') return queueAuthority;
      if (functionName === 'boringVault') {
        if (at === VAULT || at === TELLER) throw revertError('boringVault');
        return linked.includes(at) ? VAULT : OTHER;
      }
      if (at === AUTH) {
        assert.equal(args[args.length - 1], QUEUE_REQUEST_WITHDRAW_SELECTOR);
        if (functionName === 'isCapabilityPublic') return cap(args[0]) === 'public';
        if (functionName === 'getRolesWithCapability') return cap(args[0]) === 'role' ? ROLE_1 : zeroHash;
        if (functionName === 'canCall') return cap(args[1]) === 'public';
      }
      throw new Error(`unexpected read ${functionName} on ${address}`);
    },
  };
}

test('QUEUE_REQUEST_WITHDRAW_SELECTOR matches the queue ABI', () => {
  assert.equal(QUEUE_REQUEST_WITHDRAW_SELECTOR, toFunctionSelector(getAbiItem({ abi: boringQueueAbi, name: 'requestOnChainWithdraw' })));
});

test('an explicit queue that does not report boringVault() == vault is rejected', async () => {
  await assert.rejects(discoverConfig(discoveryPc({ linked: [] }), VAULT, { queue: QUEUE }), /wrong, stale/);
});

test('an explicit active queue is accepted, chainId comes from the RPC', async () => {
  const d = await discoverConfig(discoveryPc(), VAULT, { queue: QUEUE });
  assert.equal(d.config.queue, QUEUE);
  assert.equal(d.config.chainId, 1);
  assert.equal(d.queueUnknown, false);
  assert.equal(d.queueDeprecated, false);
  assert.deepEqual(d.warnings, []);
});

test('an explicit role-gated queue is not deprecated', async () => {
  const d = await discoverConfig(discoveryPc({ capability: { [QUEUE]: 'role' } }), VAULT, { queue: QUEUE });
  assert.equal(d.queueDeprecated, false);
});

test('an explicit deprecated queue is kept but flagged, with a warning', async () => {
  const d = await discoverConfig(discoveryPc({ capability: { [QUEUE]: 'none' } }), VAULT, { queue: QUEUE });
  assert.equal(d.config.queue, QUEUE);
  assert.equal(d.queueDeprecated, true);
  assert.match(d.warnings.join(' '), /is deprecated.*new withdrawal requests are disabled/);
});

test('the queue scan skips a newer deprecated queue', async () => {
  const pc = discoveryPc({ linked: [QUEUE, OTHER], capability: { [OTHER]: 'none' }, scanTargets: [QUEUE, OTHER] });
  const d = await discoverConfig(pc, VAULT);
  assert.equal(d.config.queue, QUEUE);
  assert.deepEqual(d.warnings, []);
});

test('the queue scan keeps a role-gated queue', async () => {
  const pc = discoveryPc({ linked: [QUEUE], capability: { [QUEUE]: 'role' }, scanTargets: [QUEUE] });
  assert.equal((await discoverConfig(pc, VAULT)).config.queue, QUEUE);
});

test('the queue scan reports linked queues that are all deprecated', async () => {
  const pc = discoveryPc({ linked: [QUEUE, OTHER], capability: { [QUEUE]: 'none', [OTHER]: 'none' }, scanTargets: [QUEUE, OTHER] });
  const d = await discoverConfig(pc, VAULT);
  assert.equal(d.queueUnknown, true);
  assert.match(d.warnings.join(' '), /Found 2 BoringOnChainQueue\(s\) linked to the vault, all deprecated/);
  assert.doesNotMatch(d.warnings.join(' '), /No BoringOnChainQueue found/);
});

test('a capability read that throws during the scan falls through to the next candidate', async () => {
  const pc = discoveryPc({ linked: [QUEUE, OTHER], capability: { [OTHER]: 'throws' }, scanTargets: [QUEUE, OTHER] });
  const d = await discoverConfig(pc, VAULT);
  assert.equal(d.config.queue, QUEUE);
  assert.deepEqual(d.warnings, []);
});

test('the scan keeps an unreadable queue unverified rather than reporting none', async () => {
  const pc = discoveryPc({ linked: [QUEUE, OTHER], capability: { [QUEUE]: 'throws', [OTHER]: 'none' }, scanTargets: [QUEUE, OTHER] });
  const d = await discoverConfig(pc, VAULT);
  assert.equal(d.config.queue, QUEUE);
  assert.equal(d.queueUnknown, false);
  assert.match(d.warnings.join(' '), /using it unverified/);
  assert.doesNotMatch(d.warnings.join(' '), /all deprecated/);
});

test('an unreadable capability on an explicit queue does not fail discovery', async () => {
  const d = await discoverConfig(discoveryPc({ capability: { [QUEUE]: 'throws' } }), VAULT, { queue: QUEUE });
  assert.equal(d.config.queue, QUEUE);
  assert.equal(d.queueDeprecated, false);
  assert.match(d.warnings.join(' '), /Could not read whether queue .* still accepts withdrawal requests/);
});

test('a rate-limited deprecation read rejects discovery instead of a warning or an unverified queue', async () => {
  const limited = (pc) => {
    const read = pc.readContract;
    pc.readContract = async (call) => {
      if (call.functionName === 'isCapabilityPublic') throw Object.assign(new Error('rate limited'), { code: 429 });
      return read(call);
    };
    return pc;
  };
  await assert.rejects(discoverConfig(limited(discoveryPc()), VAULT, { queue: QUEUE }), /rate limited/);
  await assert.rejects(discoverConfig(limited(discoveryPc({ scanTargets: [QUEUE] })), VAULT), /rate limited/);
});

test('isQueueDeprecated returns false when a role holds the capability even if isCapabilityPublic fails', async () => {
  const pc = {
    readContract: async ({ functionName }) => {
      if (functionName === 'isCapabilityPublic') throw new HttpRequestError({ url: 'https://rpc.example', status: 503 });
      return ROLE_1;
    },
  };
  assert.equal(await isQueueDeprecated(pc, AUTH, QUEUE), false);
});

test('an explicit queue under a different authority than the vault gets a warning', async () => {
  const d = await discoverConfig(discoveryPc({ queueAuthority: OTHER }), VAULT, { queue: QUEUE });
  assert.match(d.warnings.join(' '), new RegExp(`uses authority ${OTHER}, not the vault's ${AUTH}`));
});

test('skipQueueScan leaves the queue unknown without scanning the authority', async () => {
  const pc = discoveryPc({ scanTargets: [QUEUE] });
  let getLogsCalls = 0;
  pc.getLogs = async () => { getLogsCalls++; return []; };
  const d = await discoverConfig(pc, VAULT, { skipQueueScan: true });
  assert.equal(getLogsCalls, 0);
  assert.equal(d.queueUnknown, true);
  assert.match(d.warnings.join(' '), /Queue scan skipped/);
});

test('a scanned queue under a different authority also gets the warning', async () => {
  const pc = discoveryPc({ scanTargets: [QUEUE], queueAuthority: OTHER });
  const d = await discoverConfig(pc, VAULT);
  assert.equal(d.config.queue, QUEUE);
  assert.match(d.warnings.join(' '), /uses authority/);
});

test('queues picks the first candidate that belongs to the vault and is active', async () => {
  const NEWER = '0x' + '99'.repeat(20);
  const pc = discoveryPc({ linked: [QUEUE, NEWER], capability: { [NEWER]: 'none' } });
  let getLogsCalls = 0;
  pc.getLogs = async () => { getLogsCalls++; return []; };
  const d = await discoverConfig(pc, VAULT, { queues: [OTHER, NEWER, QUEUE] });
  assert.equal(d.config.queue, QUEUE);
  assert.equal(getLogsCalls, 0);
  assert.match(d.warnings.join(' '), new RegExp(`Candidate queue ${OTHER} reports boringVault`));
  assert.match(d.warnings.join(' '), new RegExp(`Candidate queue ${NEWER} is deprecated`));
});

test('queues with no active candidate leaves the queue unknown without scanning', async () => {
  const pc = discoveryPc({ capability: { [QUEUE]: 'none' }, scanTargets: [QUEUE] });
  let getLogsCalls = 0;
  pc.getLogs = async () => { getLogsCalls++; return []; };
  const d = await discoverConfig(pc, VAULT, { queues: [QUEUE] });
  assert.equal(getLogsCalls, 0);
  assert.equal(d.queueUnknown, true);
  assert.match(d.warnings.join(' '), /None of the candidate queues is active/);
});

test('a candidate queue under a different authority than the vault gets a warning', async () => {
  const d = await discoverConfig(discoveryPc({ queueAuthority: OTHER }), VAULT, { queues: [QUEUE] });
  assert.equal(d.config.queue, QUEUE);
  assert.match(d.warnings.join(' '), new RegExp(`uses authority ${OTHER}, not the vault's ${AUTH}`));
});

test('an explicit queue reads its authority alongside the boringVault check', async () => {
  const pc = discoveryPc();
  const read = pc.readContract;
  let authorityRequested = false;
  let authorityRequestedDuringBoringVault = false;
  pc.readContract = async (call) => {
    if (call.address === QUEUE && call.functionName === 'authority') authorityRequested = true;
    if (call.address === QUEUE && call.functionName === 'boringVault') {
      await new Promise((resolve) => setImmediate(resolve));
      authorityRequestedDuringBoringVault = authorityRequested;
    }
    return read(call);
  };
  await discoverConfig(pc, VAULT, { queue: QUEUE });
  assert.equal(authorityRequestedDuringBoringVault, true);
});

test('queues rejects on an RPC failure instead of falling to the next candidate', async () => {
  const pc = discoveryPc({ linked: [QUEUE, OTHER] });
  const read = pc.readContract;
  pc.readContract = async (call) => {
    if (call.functionName === 'boringVault' && call.address === OTHER) throw new Error('503 Service Unavailable');
    return read(call);
  };
  await assert.rejects(discoverConfig(pc, VAULT, { queues: [OTHER, QUEUE] }), /503/);
});

test('an RPC failure on boringVault() rejects discovery instead of reporting a wrong or missing queue', async () => {
  const down = (pc) => {
    const read = pc.readContract;
    pc.readContract = async (call) => {
      if (call.functionName === 'boringVault' && call.address === QUEUE) throw new HttpRequestError({ url: 'https://rpc.example', status: 503 });
      return read(call);
    };
    return pc;
  };
  await assert.rejects(discoverConfig(down(discoveryPc()), VAULT, { queue: QUEUE }), { name: 'HttpRequestError' });
  await assert.rejects(discoverConfig(down(discoveryPc({ scanTargets: [QUEUE] })), VAULT), { name: 'HttpRequestError' });
});

test('the scan skips and names targets whose boringVault() fails for reasons other than the network', async () => {
  const pc = discoveryPc({ linked: [QUEUE], scanTargets: [QUEUE, OTHER] });
  const read = pc.readContract;
  pc.readContract = async (call) => {
    if (call.functionName === 'boringVault' && call.address === OTHER) throw new Error('out of gas');
    return read(call);
  };
  const d = await discoverConfig(pc, VAULT);
  assert.equal(d.config.queue, QUEUE);
  assert.match(d.warnings.join(' '), new RegExp(`Could not read boringVault\\(\\) on 1 authority target\\(s\\) \\(${OTHER}\\)`));
});

test('an explicit queue or candidate whose boringVault() returns undecodable data is treated as not a queue', async () => {
  const decodeError = () => Object.assign(new Error('decode failed'), { cause: Object.assign(new Error('short'), { name: 'AbiDecodingDataSizeTooSmallError' }) });
  const pc = discoveryPc({ linked: [QUEUE] });
  const read = pc.readContract;
  pc.readContract = async (call) => {
    if (call.functionName === 'boringVault' && call.address === OTHER) throw decodeError();
    return read(call);
  };
  await assert.rejects(discoverConfig(pc, VAULT, { queue: OTHER }), /wrong, stale, or non-queue/);
  assert.equal((await discoverConfig(pc, VAULT, { queues: [OTHER, QUEUE] })).config.queue, QUEUE);
});

test('a queue whose authority() fails for a network reason gets a warning instead of a silent skip', async () => {
  const pc = discoveryPc();
  const read = pc.readContract;
  pc.readContract = async (call) => {
    if (call.functionName === 'authority' && call.address === QUEUE) throw new HttpRequestError({ url: 'https://rpc.example', status: 503 });
    return read(call);
  };
  const d = await discoverConfig(pc, VAULT, { queue: QUEUE });
  assert.match(d.warnings.join(' '), /Could not read queue .*'s authority/);
});

test('isQueueDeprecated surfaces a non-revert failure even when its reason is undefined', async () => {
  const pc = {
    readContract: async ({ functionName }) => {
      if (functionName === 'isCapabilityPublic') throw revertError('isCapabilityPublic');
      throw undefined;
    },
  };
  const reason = await isQueueDeprecated(pc, AUTH, QUEUE).then(() => assert.fail('expected a rejection'), (e) => e);
  assert.equal(reason, undefined);
});

test('a cyclic error cause chain from a queue read rejects instead of hanging', async () => {
  const pc = discoveryPc();
  const read = pc.readContract;
  pc.readContract = async (call) => {
    if (call.functionName === 'boringVault' && call.address === QUEUE) {
      const e = new Error('loop');
      e.cause = e;
      throw e;
    }
    return read(call);
  };
  await assert.rejects(discoverConfig(pc, VAULT, { queue: QUEUE }), /loop/);
});

test('a scan target whose boringVault() returns undecodable data is skipped, not fatal', async () => {
  const pc = discoveryPc({ linked: [QUEUE], scanTargets: [QUEUE, OTHER] });
  const read = pc.readContract;
  pc.readContract = async (call) => {
    if (call.functionName === 'boringVault' && call.address === OTHER) {
      throw Object.assign(new Error('decode failed'), { cause: Object.assign(new Error('short'), { name: 'AbiDecodingDataSizeTooSmallError' }) });
    }
    return read(call);
  };
  assert.equal((await discoverConfig(pc, VAULT)).config.queue, QUEUE);
});

function withdrawPc(opts) {
  const base = discoveryPc(opts);
  return {
    ...base,
    readContract: async (call) => {
      switch (call.functionName) {
        case 'withdrawAssets': return [true, 0, 0, 1, 100, 1n];
        case 'balanceOf': return 10n;
        case 'decimals': return 6;
        case 'getRateInQuoteSafe': return 1_000_000n;
        case 'allowance': return 0n;
        case 'isPaused': return opts?.paused ?? false;
        case 'shareUnlockTime': return 0n;
        case 'previewAssetsOut': return 9n;
      }
      return base.readContract(call);
    },
  };
}

const WITHDRAW_CFG = { vault: VAULT, teller: TELLER, accountant: ACC, queue: QUEUE, rolesAuthority: AUTH, chainId: 1 };
const ASSET = '0x' + '88'.repeat(20);

test('planRequestWithdraw on an active queue has no permission blocker', async () => {
  const plan = await planRequestWithdraw(withdrawPc(), WITHDRAW_CFG, { assetOut: ASSET, shares: 5n, owner: DEAD });
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.steps.at(-1).kind, 'requestWithdraw');
});

test('planRequestWithdraw on a deprecated queue is blocked with QUEUE_DEPRECATED', async () => {
  const plan = await planRequestWithdraw(withdrawPc({ capability: { [QUEUE]: 'none' } }), WITHDRAW_CFG, { assetOut: ASSET, shares: 5n, owner: DEAD });
  assert.deepEqual(plan.blockers.map((b) => b.code), ['QUEUE_DEPRECATED']);
  assert.match(plan.blockers[0].message, /no longer accepts withdrawal requests — use the vault's current queue/);
  assert.equal(plan.steps.length, 0);
});

test('a deprecated queue that is also paused reports QUEUE_DEPRECATED first', async () => {
  const plan = await planRequestWithdraw(withdrawPc({ capability: { [QUEUE]: 'none' }, paused: true }), WITHDRAW_CFG, { assetOut: ASSET, shares: 5n, owner: DEAD });
  assert.deepEqual(plan.blockers.map((b) => b.code), ['QUEUE_DEPRECATED', 'PAUSED']);
});

test('planRequestWithdraw rejects when the deprecation check hits an RPC failure instead of reporting ROLE_DENIED', async () => {
  const pc = withdrawPc({ capability: { [QUEUE]: 'none' } });
  const read = pc.readContract;
  pc.readContract = async (call) => {
    if (call.functionName === 'getRolesWithCapability') throw new Error('503 Service Unavailable');
    return read(call);
  };
  await assert.rejects(planRequestWithdraw(pc, WITHDRAW_CFG, { assetOut: ASSET, shares: 5n, owner: DEAD }), /503/);
});

test('an RPC failure in one deprecation read is not hidden by a revert in the other', async () => {
  const pc = withdrawPc({ capability: { [QUEUE]: 'none' } });
  const read = pc.readContract;
  pc.readContract = async (call) => {
    if (call.functionName === 'isCapabilityPublic') throw revertError('isCapabilityPublic');
    if (call.functionName === 'getRolesWithCapability') {
      await new Promise((r) => setTimeout(r, 20));
      throw new Error('503 Service Unavailable');
    }
    return read(call);
  };
  await assert.rejects(planRequestWithdraw(pc, WITHDRAW_CFG, { assetOut: ASSET, shares: 5n, owner: DEAD }), /503/);
});

test('planRequestWithdraw on a role-gated queue the owner lacks is blocked with ROLE_DENIED', async () => {
  const plan = await planRequestWithdraw(withdrawPc({ capability: { [QUEUE]: 'role' } }), WITHDRAW_CFG, { assetOut: ASSET, shares: 5n, owner: DEAD });
  assert.deepEqual(plan.blockers.map((b) => b.code), ['ROLE_DENIED']);
});

// ---------- plan composition ----------

const M_ASSET = '0x' + 'aa'.repeat(20);
const M_OWNER = '0x' + 'bb'.repeat(20);
const MVAULT = '0x' + 'cc'.repeat(20);

function morphoPc(call) {
  const noGate = revertError('receiveSharesGate');
  return fakePc({
    [`${MVAULT}.symbol`]: 'sUSDT',
    [`${MVAULT}.decimals`]: 6,
    [`${MVAULT}.asset`]: M_ASSET,
    [`${MVAULT}.totalAssets`]: 0n,
    [`${MVAULT}.balanceOf`]: 0n,
    [`${MVAULT}.maxWithdraw`]: 0n,
    [`${MVAULT}.previewDeposit`]: 10n,
    [`${MVAULT}.receiveSharesGate`]: noGate,
    [`${MVAULT}.sendSharesGate`]: noGate,
    [`${MVAULT}.receiveAssetsGate`]: noGate,
    [`${MVAULT}.sendAssetsGate`]: noGate,
    [`${M_ASSET}.symbol`]: 'USDT',
    [`${M_ASSET}.decimals`]: 6,
    [`${M_ASSET}.balanceOf`]: 100n,
    [`${M_ASSET}.allowance`]: 5n,
  }, { call });
}

test('morpho planDeposit stamps chainId and resets residual allowances the token will not overwrite', async () => {
  const plan = await morphoPlanDeposit(morphoPc(async () => { throw new ExecutionRevertedError(); }), MVAULT, { assets: 10n, owner: M_OWNER });
  assert.equal(plan.chainId, 1);
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.steps.map((s) => s.kind), ['approveReset', 'approve', 'deposit']);
  assert.ok(plan.steps[0].data.endsWith('0'.repeat(64)), 'reset step must approve amount 0');
  assert.equal(plan.steps[0].to, M_ASSET);
});

test('the reset is dropped only on a simulation from the owner against the asset itself', async () => {
  const seen = [];
  const plan = await morphoPlanDeposit(morphoPc(async (req) => { seen.push(req); return { data: undefined }; }), MVAULT, { assets: 10n, owner: M_OWNER });
  assert.deepEqual(plan.steps.map((s) => s.kind), ['approve', 'deposit']);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].account, M_OWNER);
  assert.equal(seen[0].to, M_ASSET);
  assert.equal(seen[0].data, plan.steps[0].data);
});

test('an RPC failure during the approve simulation fails the plan as retryable RPC_ERROR instead of dropping or guessing the reset', async () => {
  const flaky = morphoPc(async (req) => {
    throw new CallExecutionError(new HttpRequestError({ url: 'https://rpc.example/secret-key', status: 503 }), req);
  });
  const err = await morphoPlanDeposit(flaky, MVAULT, { assets: 10n, owner: M_OWNER }).then(() => assert.fail('must throw'), (e) => e);
  const cli = toCliError(err);
  assert.equal(cli.code, 'RPC_ERROR');
  assert.equal(cli.exitCode, 4);
  assert.equal(cli.retryable, true);
  assert.doesNotMatch(`${cli.message} ${cli.hint}`, /secret-key/);
});
