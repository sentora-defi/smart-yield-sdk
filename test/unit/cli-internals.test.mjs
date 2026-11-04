import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { IntegerOutOfRangeError, InvalidAddressError } from 'viem';
import { humanTwins, finalizeResult, asPlan } from '../../packages/vaults-cli/src/result.ts';
import { CliError, toCliError, sanitizeErrorMessage, isRpcShapedError } from '../../packages/vaults-cli/src/errors.ts';
import { escapeControl, printError, printResult, toJson } from '../../packages/vaults-cli/src/output.ts';
import { commandHelp, familyHelp, rootHelp } from '../../packages/vaults-cli/src/help.ts';
import { agentHost, sandboxNetworkDisabled } from '../../packages/vaults-cli/src/agent.ts';
import { findCommand } from '../../packages/vaults-cli/src/registry.ts';
import {
  isAddress, makeClient, makeFetch, optionalAddress, optionalAmount, optionalBigInt, optionalInt, redactUrl, shown,
  requireAddress, requireBigInt, requireString, timeoutMs,
} from '../../packages/vaults-cli/src/helpers.ts';

const CLI_BUNDLE = fileURLToPath(new URL('../../packages/vaults-cli/dist/cli.mjs', import.meta.url));
const CLI_SRC = fileURLToPath(new URL('../../packages/vaults-cli/src/cli.ts', import.meta.url));
const ARGV = process.env.NODE_V8_COVERAGE ? ['--import', 'tsx', CLI_SRC] : [CLI_BUNDLE];

function raw(args, envOverride = {}) {
  const env = { ...process.env, VAULTS_RPC_URL: '', SENTORA_RPC_URL: '', ETH_RPC_URL: '', ...envOverride };
  for (const k of Object.keys(env)) if (env[k] === '') delete env[k];
  const res = spawnSync(process.execPath, [...ARGV, ...args], { encoding: 'utf8', env, timeout: 60_000 });
  let json, error;
  try { json = JSON.parse(res.stdout); } catch { /* not JSON */ }
  try { error = JSON.parse(res.stderr)?.error; } catch { /* not JSON */ }
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, json, error };
}

function withEnv(t, vars) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

const NO_AGENT = {
  CODEX_SANDBOX: undefined, CODEX_SANDBOX_NETWORK_DISABLED: undefined, CLAUDECODE: undefined, GEMINI_CLI: undefined,
};

function capture(stream, fn) {
  const original = stream.write;
  let out = '';
  stream.write = (chunk) => { out += chunk; return true; };
  try { fn(); } finally { stream.write = original; }
  return out;
}

test('humanTwins: plans get expectedFormatted for the roles whose decimals are known', () => {
  const plan = {
    steps: [], blockers: [],
    expected: { assets: '1500000', shares: '2000000000000000000', minimumMint: 'n/a', unknownRole: '5' },
    context: { assetDecimals: 6, shareDecimals: 18 },
  };
  assert.deepEqual(humanTwins(plan).expectedFormatted, { assets: '1.5', shares: '2' });
  const noDecimals = { steps: [], blockers: [], expected: { assets: '1' } };
  assert.equal(humanTwins(noDecimals), noDecimals);
  const noExpected = { steps: [], blockers: [], context: { assetDecimals: 6 } };
  assert.equal(humanTwins(noExpected), noExpected);
});

test('humanTwins: meta-shaped results get formatted, other values pass through untouched', () => {
  const meta = { assetDecimals: 6, totalAssets: 2_500_000n, depositCap: 10n ** 7n, sharePrice: '1' };
  assert.deepEqual(humanTwins(meta).formatted, { totalAssets: '2.5', depositCap: '10' });
  const withSupply = { assetDecimals: 6, shareDecimals: 18, totalAssets: 0n, totalSupply: 10n ** 18n };
  assert.deepEqual(humanTwins(withSupply).formatted, { totalAssets: '0', totalSupply: '1' });
  const supplyNoDecimals = { assetDecimals: 6, totalAssets: 1n, totalSupply: 5n };
  assert.deepEqual(humanTwins(supplyNoDecimals).formatted, { totalAssets: '0.000001' });
  for (const v of [null, 'x', 5, [1, 2], { assetDecimals: 6, totalAssets: '1' }]) assert.equal(humanTwins(v), v);
});

test('finalizeResult stamps schemaVersion on plans only and flags blockers', () => {
  const blocked = finalizeResult({ steps: [], blockers: [{ code: 'PAUSED' }], expected: {} });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.payload.schemaVersion, 1);
  assert.equal(finalizeResult({ steps: [], blockers: [] }).blocked, false);
  assert.deepEqual(finalizeResult({ a: 1 }), { payload: { a: 1 }, blocked: false });
  assert.equal(asPlan(null), undefined);
  assert.equal(asPlan({ steps: [], blockers: 'no' }), undefined);
});

test('toCliError: yields API statuses map to NOT_FOUND, retryability and auth hints', () => {
  const api = (status) => toCliError(Object.assign(new Error('boom'), { name: 'YieldsApiError', status }));
  for (const status of [401, 403]) {
    const e = api(status);
    assert.equal(e.code, 'UPSTREAM_API');
    assert.equal(e.retryable, false);
    assert.match(e.hint, /YIELDS_API_KEY/);
  }
  assert.equal(api(429).retryable, true);
  assert.equal(api(503).retryable, true);
  assert.equal(api(404).code, 'NOT_FOUND');
  assert.equal(api(404).exitCode, 3);
  assert.equal(api(404).retryable, false);
  assert.match(api(404).hint, /--base-url/);
  assert.equal(api(undefined).retryable, false);
  assert.equal(api(503).exitCode, 5);
});

test('toCliError: socket codes deep in the cause chain are network failures', (t) => {
  withEnv(t, NO_AGENT);
  const e = toCliError(Object.assign(new Error('outer'), { cause: { cause: { code: 'ECONNREFUSED' } } }));
  assert.equal(e.code, 'RPC_ERROR');
  assert.match(e.message, /Network request failed \(ECONNREFUSED\): outer/);
  assert.equal(e.retryable, true);
  assert.equal(e.hint, 'Verify the endpoint is reachable and retry.');
  const fetchFailed = toCliError(Object.assign(new TypeError('fetch failed')));
  assert.equal(fetchFailed.code, 'RPC_ERROR');
  assert.match(fetchFailed.message, /^Network request failed: fetch failed/);
  assert.equal(toCliError(Object.assign(new Error('x'), { code: 'EPERM' })).code, 'UNEXPECTED');
});

test('toCliError: EPERM counts as a network failure only inside a sandbox', (t) => {
  withEnv(t, { ...NO_AGENT, CODEX_SANDBOX: 'seatbelt' });
  const e = toCliError(Object.assign(new Error('connect EPERM'), { code: 'EPERM' }));
  assert.equal(e.code, 'RPC_ERROR');
  assert.equal(e.retryable, true);
  assert.match(e.hint, /codex sandbox may be blocking network egress/);
});

test('toCliError: viem ABI-slot errors are usage errors, contract failures are CONTRACT_ERROR', () => {
  const wrap = (cause) => Object.assign(new Error('wrapped'), { name: 'ContractFunctionExecutionError', shortMessage: 'short', cause });
  const range = toCliError(wrap(new IntegerOutOfRangeError({ max: '255', min: '0', signed: false, size: 1, value: '256' })));
  assert.equal(range.code, 'USAGE');
  assert.equal(range.message, 'short');
  assert.match(range.hint, /out of range for the contract ABI slot/);
  assert.equal(toCliError(wrap(new InvalidAddressError({ address: '0x1' }))).code, 'USAGE');
  assert.equal(toCliError(wrap(new Error('reverted'))).code, 'CONTRACT_ERROR');
  assert.equal(toCliError(Object.assign(new Error('x'), { name: 'AbiDecodingZeroDataError' })).code, 'CONTRACT_ERROR');
  assert.equal(toCliError(Object.assign(new Error('x'), { name: 'CallExecutionError' })).code, 'CONTRACT_ERROR');
  assert.equal(toCliError('plain string').message, 'plain string');
  assert.equal(toCliError(null).code, 'UNEXPECTED');
  const own = new CliError('NOT_FOUND', 'gone');
  assert.equal(toCliError(own), own);
  assert.equal(own.exitCode, 3);
  assert.equal(isRpcShapedError({ name: 'X', cause: { name: 'TimeoutError' } }), true);
  assert.equal(isRpcShapedError(undefined), false);
});

test('sanitizeErrorMessage flattens control chars and truncates long messages', () => {
  assert.equal(sanitizeErrorMessage('a\nb\u001b[31m  c\u007f'), 'a b [31m c');
  const long = sanitizeErrorMessage('x'.repeat(600));
  assert.equal(long.length, 500 + '… [truncated]'.length);
  assert.match(long, /… \[truncated\]$/);
});

test('agentHost and sandboxNetworkDisabled read the agent env contracts', () => {
  assert.equal(agentHost({ CODEX_SANDBOX_NETWORK_DISABLED: '0' }), 'codex');
  assert.equal(agentHost({ CODEX_SANDBOX: 'seatbelt' }), 'codex');
  assert.equal(agentHost({ CLAUDECODE: '1' }), 'claude-code');
  assert.equal(agentHost({ GEMINI_CLI: '1' }), 'gemini-cli');
  assert.equal(agentHost({ CLAUDECODE: '0', GEMINI_CLI: '0' }), undefined);
  assert.equal(sandboxNetworkDisabled({ CODEX_SANDBOX_NETWORK_DISABLED: '1' }), true);
  assert.equal(sandboxNetworkDisabled({}), false);
});

test('output: text mode flattens every leaf and escapes control chars; JSON handles bigints', () => {
  const text = capture(process.stdout, () => printResult(
    { a: [], b: {}, c: null, d: [{ e: 1n }], 'k\ney': 'v\r\t\u0001' }, 'text', false,
  ));
  assert.equal(text, 'a=[]\nb={}\nc=null\nd[0].e=1\nk\\ney=v\\r\\t\\x01\n');
  assert.equal(capture(process.stdout, () => printResult('solo', 'text', false)), 'value=solo\n');
  assert.equal(capture(process.stdout, () => printResult([[]], 'text', false)), '[0]=[]\n');
  assert.equal(capture(process.stdout, () => printResult({ n: 2n }, 'json', true)), '{\n  "n": "2"\n}\n');
  assert.equal(toJson({ n: 1n }, false), '{"n":"1"}');
  assert.equal(escapeControl('ok'), 'ok');
});

test('output: errors in text and JSON mode, hint only when present', () => {
  const withHint = new CliError('USAGE', 'bad\nflag', { hint: 'try\u001b' });
  assert.equal(capture(process.stderr, () => printError(withHint, 'text')), 'Error (USAGE): bad\\nflag\nHint: try\\x1b\n');
  assert.equal(capture(process.stderr, () => printError(new CliError('UNEXPECTED', 'x'), 'text')), 'Error (UNEXPECTED): x\n');
  const json = JSON.parse(capture(process.stderr, () => printError(new CliError('UNEXPECTED', 'x'), 'json')));
  assert.deepEqual(json, { error: { code: 'UNEXPECTED', message: 'x', retryable: false } });
});

test('help: placeholders default to <value>, top-level commands have no family prefix', () => {
  const synthetic = {
    family: '', name: 'probe', summary: 'S', examples: ['smart-yield probe --x 1'],
    options: { x: { type: 'string', required: true, description: 'X' } },
  };
  const help = commandHelp(synthetic);
  assert.match(help, /^Usage: smart-yield probe --x <value>\n/);
  assert.doesNotMatch(help.split('\n')[0], /\[flags\]/);
  assert.match(help, /--x <value> {2}\(required\) X/);
  assert.match(commandHelp(findCommand('', 'describe')), /^Usage: smart-yield describe \[flags\]/);
  assert.match(familyHelp('boring'), /plan-withdraw/);
  assert.match(rootHelp(), /Families:/);
});

test('describe --family trims the surface; an unknown family is NOT_FOUND', async () => {
  const describe = findCommand('', 'describe');
  const only = await describe.run({ family: 'boring' });
  assert.deepEqual(new Set(only.commands.map((c) => c.command.split(' ')[0])), new Set(['boring']));
  const plan = only.commands.find((c) => c.command === 'boring plan-deposit');
  assert.deepEqual(plan.flags['--human'], { required: false, value: null, description: plan.flags['--human'].description });
  await assert.rejects(describe.run({ family: 'nope' }), (e) => e.code === 'NOT_FOUND' && /Families:/.test(e.hint));
});

test('flag helpers validate addresses, integers and strings', () => {
  const lower = '0x' + 'ab'.repeat(20);
  assert.equal(isAddress(lower), true);
  assert.equal(isAddress('0xAB' + 'ab'.repeat(19)), false);
  assert.equal(requireAddress({ a: lower }, 'a'), lower);
  assert.throws(() => requireAddress({}, 'a'), /Missing required flag --a <address>/);
  assert.throws(() => requireAddress({ a: true }, 'a'), /Missing required flag/);
  assert.throws(() => requireAddress({ a: '0x12' }, 'a'), (e) => e.code === 'USAGE' && /checksum/.test(e.hint));
  assert.equal(optionalAddress({}, 'a'), undefined);
  assert.throws(() => optionalAddress({ a: 'nope' }, 'a'), /--a must be a 0x-prefixed/);
  assert.equal(requireBigInt({ n: '12' }, 'n'), 12n);
  assert.throws(() => requireBigInt({}, 'n'), /Missing required flag --n\./);
  assert.throws(() => requireBigInt({ n: '-1' }, 'n'), /unsigned integer/);
  assert.equal(optionalBigInt({}, 'n'), undefined);
  assert.equal(optionalBigInt({ n: '0' }, 'n'), 0n);
  assert.equal(requireString({ s: 'x' }, 's'), 'x');
  assert.throws(() => requireString({ s: '' }, 's'), /Missing required flag --s\./);
  assert.equal(optionalInt({}, 'i'), undefined);
  assert.equal(optionalInt({ i: '7' }, 'i'), 7);
  assert.throws(() => optionalInt({ i: '1'.repeat(30) }, 'i', 9_999), /--i must be <= 9999, got '1{30}'/);
  assert.throws(() => optionalInt({ i: '9'.repeat(5000) }, 'i'), (e) => /too large/.test(e.message) && e.message.length < 120);
  assert.equal(shown('a'.repeat(63) + '😀' + 'b'.repeat(10)), 'a'.repeat(63) + '😀…');
  assert.throws(() => timeoutMs({ timeout: 'x'.repeat(200) }), /got 'x{64}…'/);
  assert.equal(optionalInt({ i: '7' }, 'i', 7), 7);
  assert.throws(() => optionalInt({ i: '8' }, 'i', 7), /--i must be <= 7, got '8'/);
  assert.throws(() => optionalInt({ i: 'x' }, 'i'), /unsigned integer/);
  assert.equal(timeoutMs({}), 30_000);
  assert.equal(timeoutMs({ timeout: '10' }), 10);
  assert.throws(() => timeoutMs({ timeout: '1s' }), /--timeout must be milliseconds/);
});

test('every validator caps the echoed value', async () => {
  const long = 'x'.repeat(200);
  const capped = /got 'x{64}…'/;
  const token = '0x' + '22'.repeat(20);
  assert.throws(() => requireAddress({ a: long }, 'a'), capped);
  assert.throws(() => optionalAddress({ a: long }, 'a'), capped);
  assert.throws(() => requireBigInt({ n: long }, 'n'), capped);
  const pc = { readContract: async () => 6 };
  await assert.rejects(optionalAmount(pc, { amount: long }, 'amount', token), capped);
  await assert.rejects(optionalAmount(pc, { amount: long, human: true }, 'amount', token), capped);
  await assert.rejects(optionalAmount(pc, { amount: '1.' + '1'.repeat(200), human: true }, 'amount', token), /--amount='1\.1{62}…' has/);
  const vault = '0x' + '11'.repeat(20);
  for (const args of [
    ['describe', '--output', long],
    ['snapshot', '--vault', long, '--rpc-url', 'http://127.0.0.1:1'],
    ['upshift_evm', 'plan-claim', '--vault', vault, '--owner', vault, '--year', long, '--month', '1', '--day', '1', '--rpc-url', 'http://127.0.0.1:1'],
  ]) {
    const r = raw(args);
    assert.equal(r.error?.code, 'USAGE', args.join(' '));
    assert.match(r.error.message, capped, args[0]);
  }
});

test('optionalAmount: absent is undefined, present parses like requireAmount', async () => {
  const pc = { readContract: async () => 6 };
  const token = '0x' + 'ab'.repeat(20);
  assert.equal(await optionalAmount(pc, {}, 'amount', token), undefined);
  assert.equal(await optionalAmount(pc, { amount: '42' }, 'amount', token), 42n);
  assert.equal(await optionalAmount(pc, { amount: '0.5', human: true }, 'amount', token), 500_000n);
  await assert.rejects(optionalAmount(pc, { amount: '0.5' }, 'amount', token), /base units/);
});

test('redactUrl keeps only the origin and masks any path or query', () => {
  assert.equal(redactUrl('https://rpc.example.com'), 'https://rpc.example.com');
  assert.equal(redactUrl('https://rpc.example.com/'), 'https://rpc.example.com');
  assert.equal(redactUrl('https://rpc.example.com/v2/SECRET'), 'https://rpc.example.com/…');
  assert.equal(redactUrl('https://rpc.example.com/?key=SECRET'), 'https://rpc.example.com/…');
  assert.equal(redactUrl('not a url'), '<invalid-url>');
});

test('makeClient: --rpc-url beats the env chain, which is VAULTS, SENTORA, then ETH', (t) => {
  withEnv(t, { VAULTS_RPC_URL: undefined, SENTORA_RPC_URL: undefined, ETH_RPC_URL: undefined });
  assert.throws(() => makeClient({}), (e) => e.code === 'USAGE' && /VAULTS_RPC_URL/.test(e.hint));
  process.env.ETH_RPC_URL = 'http://eth.invalid';
  assert.equal(makeClient({}).transport.url, 'http://eth.invalid');
  process.env.SENTORA_RPC_URL = 'http://sentora.invalid';
  assert.equal(makeClient({}).transport.url, 'http://sentora.invalid');
  process.env.VAULTS_RPC_URL = 'http://vaults.invalid';
  assert.equal(makeClient({}).transport.url, 'http://vaults.invalid');
  const flagged = makeClient({ 'rpc-url': 'http://flag.invalid', 'no-multicall': true });
  assert.equal(flagged.transport.url, 'http://flag.invalid');
  assert.equal(flagged.batch, undefined);
  assert.deepEqual(makeClient({ 'rpc-url': 'http://flag.invalid' }).batch, { multicall: true });
});

test('makeFetch bounds requests by --timeout and keeps a caller signal', async (t) => {
  withEnv(t, NO_AGENT);
  const server = createServer((req, res) => {
    if (req.url === '/slow') return setTimeout(() => res.end('late'), 1_000);
    if (req.url === '/stall') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.write('[');
    }
    if (req.url === '/odd') {
      res.writeHead(999);
      return res.end('odd');
    }
    res.end('ok');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const f = makeFetch({ timeout: '200' });
  assert.equal(await (await f(new URL(`${base}/fast`))).text(), 'ok');
  assert.equal(await (await f(`${base}/fast`, { signal: new AbortController().signal })).text(), 'ok');
  const timedOut = (path) => (e) =>
    e.code === 'RPC_ERROR' && e.retryable && e.message === `Yields API request ${path} timed out after 200 ms.` && !/rpc-url/.test(e.hint);
  await assert.rejects(f(`${base}/slow`), timedOut('/slow'));
  await assert.rejects(f(`${base}/stall`).then((r) => r.text()), timedOut('/stall'));
  await assert.rejects(f(new Request(`${base}/slow`)), timedOut('/slow'));
  const odd = await f(`${base}/odd`);
  assert.equal(odd.status, 999);
  assert.equal(odd.url, `${base}/odd`);
  assert.equal(await (await makeFetch({ timeout: '0' })(`${base}/slow`)).text(), 'late');
  const own = new AbortController();
  const ownPending = f(new Request(`${base}/slow`, { signal: own.signal }));
  own.abort();
  await assert.rejects(ownPending, (e) => e.name === 'AbortError');
  const ownUndefined = new AbortController();
  const ownUndefinedPending = f(new Request(`${base}/slow`, { signal: ownUndefined.signal }), { signal: undefined });
  ownUndefined.abort();
  await assert.rejects(ownUndefinedPending, (e) => e.name === 'AbortError');
  const cleared = new AbortController();
  const clearedPending = makeFetch({ timeout: '0' })(new Request(`${base}/slow`, { signal: cleared.signal }), { signal: null });
  cleared.abort();
  assert.equal(await (await clearedPending).text(), 'late');
  assert.throws(() => timeoutMs({ timeout: '3000000000' }), /--timeout must be <= 2147483647/);
  assert.equal(timeoutMs({ timeout: '2147483647' }), 2_147_483_647);
  assert.throws(() => timeoutMs({ timeout: '2147483648' }), /--timeout must be <= 2147483647/);
  const noLimit = new AbortController();
  const noLimitPending = makeFetch({ timeout: '0' })(`${base}/slow`, { signal: noLimit.signal });
  noLimit.abort();
  await assert.rejects(noLimitPending, (e) => e.name === 'AbortError');
  const caller = new AbortController();
  const pending = f(`${base}/slow`, { signal: caller.signal });
  caller.abort();
  await assert.rejects(pending, (e) => e.name === 'AbortError');
});

test('a yields API timeout inside a Codex sandbox without network is not retryable and says why', async (t) => {
  withEnv(t, { ...NO_AGENT, CODEX_SANDBOX_NETWORK_DISABLED: '1' });
  const server = createServer(() => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const f = makeFetch({ timeout: '100' });
  await assert.rejects(f(`http://127.0.0.1:${server.address().port}/vaults`), (e) =>
    e.code === 'RPC_ERROR' && e.retryable === false && /Codex sandbox/.test(e.hint));
});

test('CLI argument edge cases: missing flag value, unknown short flag, -h, unknown family without a close match', () => {
  const noValue = raw(['morpho', 'meta', '--vault']);
  assert.equal(noValue.code, 2);
  assert.equal(noValue.error.code, 'USAGE');
  assert.match(noValue.error.message, /--vault/);

  const short = raw(['morpho', 'meta', '-x']);
  assert.equal(short.code, 2);
  assert.match(short.error.message, /Unknown flag -x/);

  const unknown = raw(['morpho', 'meta', '--zzzzzzzzzzzz']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.error.hint, /^Known flags: /);

  const help = raw(['upshift_evm', 'plan-claim', '-h']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--year <yyyy>/);

  const familyHelpShort = raw(['boring', '-h']);
  assert.equal(familyHelpShort.code, 0);
  assert.match(familyHelpShort.stdout, /plan-withdraw/);

  const snapshot = raw(['snapshot']);
  assert.equal(snapshot.code, 2);
  assert.match(snapshot.error.message, /--vault <addr>\[,<addr>…\]/);
  assert.match(snapshot.error.hint, /Run 'smart-yield snapshot --help'/);

  const far = raw(['qqqqqqqqqqqq']);
  assert.equal(far.code, 2);
  assert.match(far.error.hint, /^Families: /);
});

test('CLI: --verbose on a top-level command logs without a family prefix; text-mode errors', () => {
  const r = raw(['describe', '--family', 'morpho', '--verbose']);
  assert.equal(r.code, 0);
  assert.match(r.stderr, /^# describe: ok in \d+ms$/m);
  assert.equal(r.json.commands.every((c) => c.command.startsWith('morpho ')), true);

  const text = raw(['describe', '--family', 'nope', '--output', 'text']);
  assert.equal(text.code, 3);
  assert.match(text.stderr, /^Error \(NOT_FOUND\): Unknown family 'nope'\.\nHint: Families: /);
});
