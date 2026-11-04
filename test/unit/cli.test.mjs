/**
 * No-network CLI tests: help/describe surfaces, error taxonomy + exit codes,
 * typo suggestions, output modes, and `yields list` against a local API stub.
 * Runs in milliseconds: no anvil, no RPC, no real API.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STUB_ANALYTICS, STUB_BLOCKCHAINS, STUB_VAULTS, STUB_WALLET, startYieldsStub } from './yields-stub.mjs';

const CLI_BUNDLE = fileURLToPath(new URL('../../packages/vaults-cli/dist/cli.mjs', import.meta.url));
const CLI_SRC = fileURLToPath(new URL('../../packages/vaults-cli/src/cli.ts', import.meta.url));
const ARGV = process.env.NODE_V8_COVERAGE ? ['--import', 'tsx', CLI_SRC] : [CLI_BUNDLE];

/** raw spawn — unlike helpers.cli() it does NOT append --rpc-url, and strips RPC env */
function raw(args, envOverride = {}) {
  const env = { ...process.env, VAULTS_RPC_URL: '', SENTORA_RPC_URL: '', ETH_RPC_URL: '', ...envOverride };
  for (const k of Object.keys(env)) if (env[k] === '') delete env[k];
  const res = spawnSync(process.execPath, [...ARGV, ...args], { encoding: 'utf8', env, timeout: 60_000 });
  let json, error;
  try { json = JSON.parse(res.stdout); } catch { /* not JSON */ }
  try { error = JSON.parse(res.stderr)?.error; } catch { /* not JSON */ }
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, json, error };
}

test('--version prints name and semver, exit 0', () => {
  const r = raw(['--version']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^smart-yield \d+\.\d+\.\d+/);
});

test('--help shows families and exit-code contract, exit 0', () => {
  const r = raw(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Families:/);
  assert.match(r.stdout, /7 plan blocked/);
  assert.match(r.stdout, /`available` \/ `required`/);
});

test('no arguments prints help but exits 2', () => {
  const r = raw([]);
  assert.equal(r.code, 2);
});

test('family help and command help, exit 0', () => {
  const fam = raw(['morpho', '--help']);
  assert.equal(fam.code, 0);
  assert.match(fam.stdout, /plan-deposit/);
  const cmd = raw(['morpho', 'plan-deposit', '--help']);
  assert.equal(cmd.code, 0);
  assert.match(cmd.stdout, /--assets <amount>/);
  assert.match(cmd.stdout, /Examples:/);
});

test('typo suggestions: family, command, flag — all exit 2', () => {
  const fam = raw(['morpo', 'meta']);
  assert.equal(fam.code, 2);
  assert.match(fam.error.hint, /Did you mean 'morpho'\?/);
  const cmd = raw(['morpho', 'metaa']);
  assert.equal(cmd.code, 2);
  assert.match(cmd.error.hint, /Did you mean 'meta'\?/);
  const flag = raw(['morpho', 'meta', '--valt', '0x1']);
  assert.equal(flag.code, 2);
  assert.match(flag.error.hint, /--vault/);
});

test('missing required flags are listed with usage hint, exit 2', () => {
  const r = raw(['morpho', 'plan-deposit', '--rpc-url', 'http://127.0.0.1:1']);
  assert.equal(r.code, 2);
  assert.match(r.error.message, /--vault/);
  assert.match(r.error.message, /--owner/);
  assert.match(r.error.message, /--assets/);
});

test('no RPC configured is a usage error with the env-var hint', () => {
  const r = raw(['morpho', 'meta', '--vault', '0x000000000000000000000000000000000000dEaD']);
  assert.equal(r.code, 2);
  assert.equal(r.error.code, 'USAGE');
  assert.match(r.error.hint, /VAULTS_RPC_URL/);
});

test('invalid inputs: address, timeout, output mode, human amount — exit 2 before any network use', () => {
  const dummyRpc = ['--rpc-url', 'http://127.0.0.1:1'];
  assert.equal(raw(['morpho', 'meta', '--vault', 'nothex', ...dummyRpc]).code, 2);
  assert.equal(raw(['morpho', 'meta', '--vault', '0x000000000000000000000000000000000000dEaD', '--timeout', 'abc', ...dummyRpc]).code, 2);
  assert.equal(raw(['yields', 'list', '--output', 'xml']).code, 2);
  const human = raw(['upshift_evm', 'plan-deposit', '--vault', '0x000000000000000000000000000000000000dEaD', '--owner', '0x000000000000000000000000000000000000dEaD', '--amount', '12.a', '--human', ...dummyRpc]);
  assert.equal(human.code, 2);
});

test('describe: valid JSON, schemaVersion, full command surface', () => {
  const r = raw(['describe']);
  assert.equal(r.code, 0);
  assert.equal(r.json.schemaVersion, 1);
  assert.ok(r.json.commands.length >= 22);
  assert.equal(r.json.exitCodes['7'], 'plan built and printed but has blockers — do not execute');
});

test('SKILL.md stays in sync with the command surface', async () => {
  const { readFile } = await import('node:fs/promises');
  const skill = await readFile(new URL('../../packages/vaults-cli/skills/smart-yield/SKILL.md', import.meta.url), 'utf8');
  const described = raw(['describe']).json;
  for (const family of Object.keys(described.families)) {
    assert.ok(skill.includes(`\`${family}\``), `skill must mention family '${family}'`);
  }
  for (const [code, meaning] of [[2, 'usage'], [4, 'rpc/network'], [7, 'plan blocked']]) {
    assert.ok(Object.hasOwn(described.exitCodes, String(code)), `describe must document exit ${code}`);
    assert.match(skill, new RegExp(`${code} ${meaning}`), `skill must document exit ${code} as '${meaning}'`);
  }
  assert.match(skill, /allowed-tools: Bash\(smart-yield \*\)/);
  assert.match(skill, /MUST NOT be executed/);
  assert.match(skill, /`available` \/ `required`/);
});

const NO_YIELDS_ENV = {
  YIELDS_API_KEY: '', SENTORA_API_KEY: '', YIELDS_BASE_URL: '', SENTORA_API_URL: '',
  CLAUDECODE: '', CODEX_SANDBOX: '', CODEX_SANDBOX_NETWORK_DISABLED: '', GEMINI_CLI: '',
};

test('yields list: family/curator/chain filters and paging over the API catalog', async (t) => {
  const stub = await startYieldsStub();
  t.after(stub.close);
  const list = (...args) => raw(['yields', 'list', '--base-url', stub.url, ...args], NO_YIELDS_ENV);

  const all = list();
  assert.equal(all.code, 0, all.stderr);
  assert.equal(all.json.total, STUB_VAULTS.length);
  assert.equal('notice' in all.json, false);

  const evm = list('--family', 'upshift_evm');
  assert.deepEqual(evm.json.vaults.map((v) => v.name), ['Sentora USD']);

  const ink = list('--chain', 'eip155:57073');
  assert.deepEqual(ink.json.vaults.map((v) => v.family), ['boring']);
  assert.deepEqual(list('--chain', '57073').json.vaults, ink.json.vaults);
  assert.equal(list('--chain', 'Solana').json.total, 1);
  assert.equal(list('--chain', 'solana').json.total, 1);
  assert.equal(list('--chain', '1399811149').json.total, 1);
  assert.equal(list('--chain', 'ethereum').json.total, 2);
  assert.deepEqual(list('--chain', 'ink').json.vaults, ink.json.vaults);
  assert.equal(list('--chain', 'atlantis').code, 2);
  assert.equal(list('--chain', 'eip155:').code, 2);
  assert.equal(list('--chain', 'foo:bar').json.total, 0);
  assert.equal(list('--chain', '01').code, 2);
  assert.equal(list('--chain', '1').json.total, 2);
  assert.equal(list('--curator', 'sentora').json.total, STUB_VAULTS.length);
  assert.equal(list('--featured').json.total, 1);

  const page = list('--limit', '3', '--offset', '2');
  assert.equal(page.json.returned, 2);
  assert.equal(page.json.remaining, 0);
  assert.equal(page.json.truncated, false);

  const proj = list('--limit', '1', '--fields', 'name,family');
  assert.deepEqual(Object.keys(proj.json.vaults[0]).sort(), ['family', 'name']);
});

test('snapshot: boring topology comes from the API record on the RPC chain', async (t) => {
  const boring = STUB_VAULTS.find((v) => v.family === 'boring');
  const twin = { ...boring, chainId: 'eip155:1', name: 'Ethereum twin', contracts: { ...boring.contracts, queue: '0x000000000000000000000000000000000000bEEF' } };
  const stub = await startYieldsStub([twin, ...STUB_VAULTS], { chainId: 57073 });
  t.after(stub.close);
  const r = raw(['snapshot', '--vault', boring.contracts.vault, '--base-url', stub.url, '--rpc-url', stub.url], NO_YIELDS_ENV);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.family, 'boring');
  assert.equal(r.json.name, boring.name);
  assert.equal(r.json.config.chainId, 57073);
  assert.equal(r.json.config.queue, boring.contracts.queue);
});

test('snapshot: malformed records and failing vaults do not sink the batch', async (t) => {
  const boring = STUB_VAULTS.find((v) => v.family === 'boring');
  const broken = { ...STUB_VAULTS[0], contracts: { vault: 123 } };
  const unknown = { ...STUB_VAULTS[0], chainId: 'eip155:57073', name: 'Unknown thing', family: 'unknown_evm', contracts: { vault: '0x1111111111111111111111111111111111111111' } };
  const reverting = { ...STUB_VAULTS[0], chainId: 'eip155:57073', name: 'Empty morpho', contracts: { vault: '0x2222222222222222222222222222222222222222' } };
  const stub = await startYieldsStub([broken, null, ...STUB_VAULTS, unknown, reverting], {
    chainId: 57073,
    code: { [reverting.contracts.vault]: [] },
  });
  t.after(stub.close);
  const vaults = [boring.contracts.vault, unknown.contracts.vault, reverting.contracts.vault].join(',');
  const r = raw(['snapshot', '--vault', vaults, '--base-url', stub.url, '--rpc-url', stub.url, '--no-multicall'], NO_YIELDS_ENV);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.length, 3);
  assert.equal(r.json[0].family, 'boring');
  assert.equal(r.json[0].config.queue, boring.contracts.queue);
  assert.equal(r.json[0].error, undefined);
  assert.equal(r.json[1].name, 'Unknown thing');
  assert.match(r.json[1].error, /no SDK adapter for family 'unknown_evm'/);
  assert.equal(r.json[2].family, 'morpho');
  assert.equal(r.json[2].name, 'Empty morpho');
  assert.match(r.json[2].error, /returned no data/);
});

test('snapshot: a vault listed only on another chain says where it is listed', async (t) => {
  const boring = STUB_VAULTS.find((v) => v.family === 'boring');
  const stub = await startYieldsStub(STUB_VAULTS, { chainId: 1, code: { [boring.contracts.vault]: ['hook()'] } });
  t.after(stub.close);
  const r = raw(['snapshot', '--vault', boring.contracts.vault, '--base-url', stub.url, '--rpc-url', stub.url, '--no-multicall'], NO_YIELDS_ENV);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.listedOn, ['eip155:57073']);
  assert.equal(r.json.family, 'boring');
  assert.equal(r.json.name, undefined);
  assert.match(r.json.error, /not in the catalog for eip155:1 \(listed on eip155:57073; check --rpc-url\)/);
});

test('snapshot: a null entry does not hide an unsupported schemaVersion', async (t) => {
  const boring = STUB_VAULTS.find((v) => v.family === 'boring');
  const stub = await startYieldsStub([null, { ...STUB_VAULTS[0], schemaVersion: 2 }, boring], { chainId: 57073 });
  t.after(stub.close);
  const r = raw(['snapshot', '--vault', boring.contracts.vault, '--base-url', stub.url, '--rpc-url', stub.url], NO_YIELDS_ENV);
  assert.match(r.json.catalogError, /unsupported vault schemaVersion 2/);
  assert.equal(r.json.config, undefined);
});

test('snapshot: no on-chain family probes when the API record has the family', async (t) => {
  const boring = STUB_VAULTS.find((v) => v.family === 'boring');
  const stub = await startYieldsStub([boring], { chainId: 57073 });
  t.after(stub.close);
  const r = raw(['snapshot', '--vault', boring.contracts.vault, '--base-url', stub.url, '--rpc-url', stub.url, '--verbose'], NO_YIELDS_ENV);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.family, 'boring');
  assert.doesNotMatch(r.stderr, /eth_call/);
});

test('snapshot: a failed catalog fetch is reported on the item even when on-chain detection also fails', async (t) => {
  const stub = await startYieldsStub([], { chainId: 57073 });
  t.after(stub.close);
  const vault = STUB_VAULTS.find((v) => v.family === 'boring').contracts.vault;
  const r = raw(['snapshot', '--vault', vault, '--base-url', 'http://127.0.0.1:9', '--rpc-url', stub.url, '--timeout', '3000'], NO_YIELDS_ENV);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.json.catalogError, /fetch failed/);
});

test('yields commands accept non-EVM vault addresses', async (t) => {
  const stub = await startYieldsStub();
  t.after(stub.close);
  const kamino = STUB_VAULTS.find((v) => v.family === 'kamino');
  const r = raw(['yields', 'get', '--chain-id', kamino.chainId, '--address', kamino.contracts.vault, '--base-url', stub.url], NO_YIELDS_ENV);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.name, kamino.name);

  const solWallet = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
  const bal = raw(['yields', 'balance', '--chain-id', kamino.chainId, '--address', kamino.contracts.vault, '--wallet', solWallet, '--base-url', 'http://127.0.0.1:9', '--timeout', '3000'], NO_YIELDS_ENV);
  assert.equal(bal.code, 4, bal.stderr);
});

test('yields list: bad paging flags, malformed catalog entries and unknown chains', async (t) => {
  assert.equal(raw(['yields', 'list', '--limit', 'abc', '--base-url', 'http://127.0.0.1:9', '--timeout', '3000'], NO_YIELDS_ENV).code, 2);

  const odd = { ...STUB_VAULTS[0], name: 'Odd curator', curator: { name: 'sentora' } };
  const stub = await startYieldsStub([null, odd, ...STUB_VAULTS]);
  t.after(stub.close);
  const list = (...args) => raw(['yields', 'list', '--base-url', stub.url, ...args], NO_YIELDS_ENV);
  const curated = list('--curator', 'sentora', '--fields', 'name');
  assert.equal(curated.code, 0, curated.stderr);
  assert.equal(curated.json.total, STUB_VAULTS.length);
  assert.equal(list('--chain', 'eip155:8453').json.total, 0);

  const notAList = await startYieldsStub({ vaults: STUB_VAULTS });
  t.after(notAList.close);
  const r = raw(['yields', 'list', '--base-url', notAList.url], NO_YIELDS_ENV);
  assert.equal(r.code, 5, r.stderr);
  assert.match(r.error.message, /did not return a list/);
});

test('snapshot: an invalid yields config from the env only loses the catalog', async (t) => {
  const stub = await startYieldsStub([], { chainId: 57073 });
  t.after(stub.close);
  const vault = STUB_VAULTS.find((v) => v.family === 'boring').contracts.vault;
  const r = raw(['snapshot', '--vault', vault, '--rpc-url', stub.url], { ...NO_YIELDS_ENV, YIELDS_BASE_URL: 'http://api.internal.example' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.json.catalogError, /https/);
});

test('snapshot: rejects bad boring records and unsupported family versions from the API', async (t) => {
  const boring = STUB_VAULTS.find((v) => v.family === 'boring');
  const cases = [
    [{ ...boring, contracts: { ...boring.contracts, teller: 'not-an-address' } }, /invalid teller address/],
    [{ ...boring, familyVersion: 2 }, /familyVersion 2 of 'boring' is not supported/],
  ];
  for (const [record, expected] of cases) {
    const stub = await startYieldsStub([record], { chainId: 57073 });
    t.after(stub.close);
    const r = raw(['snapshot', '--vault', boring.contracts.vault, '--base-url', stub.url, '--rpc-url', stub.url], NO_YIELDS_ENV);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.json.error, expected);
    assert.equal(r.json.config, undefined);
  }
});

test('yields API network failure maps to RPC_ERROR with the cause code, retryable, exit 4', () => {
  const r = raw(['yields', 'blockchains', '--base-url', 'http://127.0.0.1:1', '--timeout', '3000'], NO_YIELDS_ENV);
  assert.equal(r.code, 4);
  assert.equal(r.error.code, 'RPC_ERROR');
  assert.equal(r.error.retryable, true);
  assert.match(r.error.message, /Network request failed/);
});

test('agent host detected: network hint mentions the sandbox', () => {
  const r = raw(['yields', 'blockchains', '--base-url', 'http://127.0.0.1:1', '--timeout', '3000'], { ...NO_YIELDS_ENV, CLAUDECODE: '1' });
  assert.equal(r.code, 4);
  assert.equal(r.error.retryable, true);
  assert.match(r.error.hint, /claude-code sandbox may be blocking/);
});

test('Codex sandbox with network disabled: not retryable, hint names the config fix', () => {
  const api = raw(['yields', 'blockchains', '--base-url', 'http://127.0.0.1:1', '--timeout', '3000'], { ...NO_YIELDS_ENV, CODEX_SANDBOX_NETWORK_DISABLED: '1' });
  assert.equal(api.code, 4);
  assert.equal(api.error.retryable, false);
  assert.match(api.error.hint, /network_access = true/);

  const rpc = raw(
    ['morpho', 'meta', '--vault', '0x000000000000000000000000000000000000dEaD', '--rpc-url', 'http://127.0.0.1:1', '--timeout', '3000'],
    { CODEX_SANDBOX_NETWORK_DISABLED: '1' },
  );
  assert.equal(rpc.code, 4);
  assert.equal(rpc.error.retryable, false);
  assert.match(rpc.error.hint, /Codex sandbox/);
});

test('--output text emits greppable path=value lines', async (t) => {
  const stub = await startYieldsStub();
  t.after(stub.close);
  const r = raw(['yields', 'list', '--base-url', stub.url, '--limit', '1', '--fields', 'name,family', '--output', 'text'], NO_YIELDS_ENV);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^total=/m);
  assert.match(r.stdout, /^vaults\[0\]\.family=/m);
});

test('--pretty produces multi-line JSON', async (t) => {
  const stub = await startYieldsStub();
  t.after(stub.close);
  const r = raw(['yields', 'list', '--base-url', stub.url, '--limit', '1', '--pretty'], NO_YIELDS_ENV);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.split('\n').length > 5);
  JSON.parse(r.stdout);
});

const MORPHO = STUB_VAULTS.find((v) => v.family === 'morpho');
const UPSHIFT = STUB_VAULTS.find((v) => v.family === 'upshift_evm');
const BORING = STUB_VAULTS.find((v) => v.family === 'boring');
const NOWHERE = '0x0000000000000000000000000000000000000001';
const MARKET_ID = '0x3b8a1f3ac0a9d1f9b38c8d4c1f1a3a7a2f6e9e8cbd5b2f3d4a1c9e8b7a6f5e4d';

test('yields main-insights: market supply/debt for a direct vault, empty metric for a smart vault', async (t) => {
  const stub = await startYieldsStub([{ ...MORPHO, marketIds: [MARKET_ID] }, UPSHIFT]);
  t.after(stub.close);
  const insights = (...args) => raw(['yields', 'main-insights', '--base-url', stub.url, ...args], NO_YIELDS_ENV);

  const direct = insights('--chain-id', 'eip155:1', '--address', MORPHO.contracts.vault);
  assert.equal(direct.code, 0, direct.stderr);
  assert.deepEqual(direct.json.market, { blockchain: 'ethereum', protocol: 'morpho', marketId: MARKET_ID });
  assert.equal(direct.json.metric.totalSupply, '412345678.123456');
  assert.equal(direct.json.metric.lastMetricDate, '2026-10-07');

  assert.deepEqual(insights('--chain-id', '1', '--address', MORPHO.contracts.vault).json, direct.json);

  const smart = insights('--chain-id', 'eip155:1', '--address', UPSHIFT.contracts.vault);
  assert.equal(smart.code, 0, smart.stderr);
  assert.deepEqual(smart.json, { metric: {} });

  const text = insights('--chain-id', 'eip155:1', '--address', MORPHO.contracts.vault, '--output', 'text');
  assert.match(text.stdout, /^market\.marketId=0x3b8a/m);
  assert.match(text.stdout, /^metric\.totalDebtsUsd=301200000\.25$/m);
});

test('yields main-insights: a missing vault is NOT_FOUND, other upstream errors are UPSTREAM_API with retryability and hints', async (t) => {
  const path = (address) => `/vaults/${encodeURIComponent('eip155:1')}/${address}/main-insights`;
  const err = (status, message) => ({ status, body: { hasError: true, status, message, errors: [{ message }] } });
  const stub = await startYieldsStub(STUB_VAULTS, {
    routes: {
      [path('0x0000000000000000000000000000000000000500')]: err(500, 'Something went wrong'),
      [path('0x0000000000000000000000000000000000000429')]: { status: 429, text: '<html>rate limited</html>' },
      [path('0x0000000000000000000000000000000000000401')]: err(401, 'Unauthorized'),
      [path('0x0000000000000000000000000000000000000200')]: { status: 200, text: '<html>waf</html>' },
    },
  });
  t.after(stub.close);
  const insights = (address, ...args) => raw(['yields', 'main-insights', '--base-url', stub.url, '--chain-id', 'eip155:1', '--address', address, ...args], NO_YIELDS_ENV);

  const missing = insights(NOWHERE);
  assert.equal(missing.code, 3);
  assert.equal(missing.error.code, 'NOT_FOUND');
  assert.equal(missing.error.retryable, false);
  assert.equal(missing.error.message, `Vault with chainId eip155:1 and address ${NOWHERE} not found`);
  assert.match(missing.error.hint, /check the API base URL/);
  // a wrong base URL 404s on every path, so the hint is what tells it apart from a missing vault
  const wrongBase = raw(['yields', 'list', '--base-url', `${stub.url}/v2`], NO_YIELDS_ENV);
  assert.equal(wrongBase.code, 3);
  assert.match(wrongBase.error.hint, /--base-url/);

  const down = insights('0x0000000000000000000000000000000000000500');
  assert.equal(down.code, 5);
  assert.equal(down.error.retryable, true);
  assert.equal(down.error.message, 'Something went wrong');

  const limited = insights('0x0000000000000000000000000000000000000429');
  assert.equal(limited.code, 5);
  assert.equal(limited.error.retryable, true);
  assert.equal(limited.error.message, '<html>rate limited</html>');

  const denied = insights('0x0000000000000000000000000000000000000401');
  assert.equal(denied.code, 5);
  assert.equal(denied.error.retryable, false);
  assert.match(denied.error.hint, /YIELDS_API_KEY/);

  const notJson = insights('0x0000000000000000000000000000000000000200');
  assert.equal(notJson.code, 5);
  assert.match(notJson.error.message, /expected a JSON body, got: <html>waf<\/html>/);

  const text = insights('0x0000000000000000000000000000000000000401', '--output', 'text');
  assert.equal(text.code, 5);
  assert.match(text.stderr, /^Error \(UPSTREAM_API\): Unauthorized$/m);
  assert.match(text.stderr, /^Hint: Authentication failed/m);
});

test('yields list: unsupported schemaVersion and non-list bodies are UPSTREAM_API, non-object entries are skipped', async (t) => {
  const v2 = await startYieldsStub([...STUB_VAULTS, { ...STUB_VAULTS[0], schemaVersion: 2 }]);
  t.after(v2.close);
  const unsupported = raw(['yields', 'list', '--base-url', v2.url], NO_YIELDS_ENV);
  assert.equal(unsupported.code, 5);
  assert.equal(unsupported.error.code, 'UPSTREAM_API');
  assert.equal(unsupported.error.message, 'unsupported vault schemaVersion 2');

  const missingVersion = await startYieldsStub([{ ...STUB_VAULTS[0], schemaVersion: undefined }]);
  t.after(missingVersion.close);
  assert.match(raw(['yields', 'list', '--base-url', missingVersion.url], NO_YIELDS_ENV).error.message, /unsupported vault schemaVersion undefined/);

  for (const body of [{ vaults: STUB_VAULTS }, 'vaults', null]) {
    const stub = await startYieldsStub(body);
    t.after(stub.close);
    const r = raw(['yields', 'list', '--base-url', stub.url], NO_YIELDS_ENV);
    assert.equal(r.code, 5, JSON.stringify(body));
    assert.equal(r.error.code, 'UPSTREAM_API');
    assert.equal(r.error.message, 'GET /vaults did not return a list');
  }

  const junk = await startYieldsStub([null, 42, 'vault', true, [], ...STUB_VAULTS]);
  t.after(junk.close);
  const r = raw(['yields', 'list', '--base-url', junk.url, '--fields', 'name'], NO_YIELDS_ENV);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.total, STUB_VAULTS.length);
  assert.deepEqual(r.json.vaults.map((v) => v.name), STUB_VAULTS.map((v) => v.name));
});

test('yields list and get: a pre-migration record without contracts does not break the catalog', async (t) => {
  const legacy = { schemaVersion: 1, chainId: 'eip155:1', name: 'Legacy row', status: 'active', type: 'direct', family: 'morpho', familyVersion: 1, vendor: 'morpho', curator: 'sentora' };
  const stub = await startYieldsStub([legacy, ...STUB_VAULTS], { chainId: 57073 });
  t.after(stub.close);

  const list = raw(['yields', 'list', '--base-url', stub.url, '--fields', 'name,contracts'], NO_YIELDS_ENV);
  assert.equal(list.code, 0, list.stderr);
  assert.equal(list.json.total, STUB_VAULTS.length + 1);
  assert.deepEqual(list.json.vaults[0], { name: 'Legacy row' });

  const get = raw(['yields', 'get', '--chain-id', 'eip155:1', '--address', MORPHO.contracts.vault, '--base-url', stub.url], NO_YIELDS_ENV);
  assert.equal(get.code, 0, get.stderr);
  assert.equal(get.json.name, MORPHO.name);

  const snap = raw(['snapshot', '--vault', BORING.contracts.vault, '--base-url', stub.url, '--rpc-url', stub.url], NO_YIELDS_ENV);
  assert.equal(snap.code, 0, snap.stderr);
  assert.equal(snap.json.config.teller, BORING.contracts.teller);
});

test('yields list: vendor, curator, family, featured, fields and offset filters', async (t) => {
  const stub = await startYieldsStub();
  t.after(stub.close);
  const list = (...args) => raw(['yields', 'list', '--base-url', stub.url, ...args], NO_YIELDS_ENV);

  const veda = list('--vendor', 'veda');
  assert.equal(veda.code, 0, veda.stderr);
  assert.deepEqual(veda.json.vaults.map((v) => v.family), ['boring']);
  assert.deepEqual(list('--vendor', 'VEDA').json.vaults, veda.json.vaults);

  const other = list('--curator', 'other');
  assert.equal(other.code, 0, other.stderr);
  assert.deepEqual(
    { total: other.json.total, returned: other.json.returned, truncated: other.json.truncated, remaining: other.json.remaining, vaults: other.json.vaults },
    { total: 0, returned: 0, truncated: false, remaining: 0, vaults: [] },
  );

  assert.deepEqual(list('--family', 'UPSHIFT_EVM').json.vaults.map((v) => v.name), ['Sentora USD']);
  assert.deepEqual(list('--family', 'Boring').json.vaults.map((v) => v.name), ['Advanced Strategies BTC']);
  assert.equal(list('--family', 'upshift-evm').json.total, 0);

  assert.deepEqual(list('--featured').json.vaults.map((v) => v.name), [MORPHO.name]);
  assert.equal(list('--featured', '--chain', 'ink').json.total, 0);
  assert.deepEqual(list('--vendor', 'veda', '--curator', 'sentora', '--chain', '57073').json.vaults.map((v) => v.name), [BORING.name]);

  const proj = list('--fields', 'name, contracts ,nope');
  assert.deepEqual(Object.keys(proj.json.vaults[2]).sort(), ['contracts', 'name']);
  assert.deepEqual(proj.json.vaults[2].contracts, BORING.contracts);

  const past = list('--offset', '10');
  assert.equal(past.code, 0, past.stderr);
  assert.deepEqual(
    { total: past.json.total, offset: past.json.offset, returned: past.json.returned, truncated: past.json.truncated, remaining: past.json.remaining },
    { total: STUB_VAULTS.length, offset: 10, returned: 0, truncated: false, remaining: 0 },
  );

  const none = list('--limit', '0');
  assert.equal(none.json.returned, 0);
  assert.equal(none.json.truncated, true);
  assert.equal(none.json.remaining, STUB_VAULTS.length);

  assert.equal(list('--offset', '-1').code, 2);
});

test('snapshot: a record without family falls back to on-chain detection', async (t) => {
  const { family: _family, familyVersion: _familyVersion, ...noFamily } = BORING;
  const stub = await startYieldsStub([noFamily], { chainId: 57073, code: { [BORING.contracts.vault]: ['hook()'] } });
  t.after(stub.close);
  const r = raw(['snapshot', '--vault', BORING.contracts.vault, '--base-url', stub.url, '--rpc-url', stub.url, '--no-multicall', '--verbose'], NO_YIELDS_ENV);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.family, 'boring');
  assert.equal(r.json.name, BORING.name);
  assert.equal(r.json.config.rolesAuthority, BORING.contracts.rolesAuthority);
  assert.match(r.stderr, new RegExp(`eth_call → ${BORING.contracts.vault}`));
});

test('snapshot: unknown family and incomplete boring topology are item errors', async (t) => {
  const { queue: _queue, ...noQueue } = BORING.contracts;
  const exotic = { ...BORING, family: 'exotic_vault' };
  const partial = { ...BORING, contracts: noQueue };
  for (const [record, expected] of [
    [exotic, /^no SDK adapter for family 'exotic_vault'$/],
    [partial, /^boring topology is not in the catalog for eip155:57073; use 'smart-yield boring discover' with explicit flags$/],
  ]) {
    const stub = await startYieldsStub([record], { chainId: 57073 });
    t.after(stub.close);
    const r = raw(['snapshot', '--vault', BORING.contracts.vault, '--base-url', stub.url, '--rpc-url', stub.url], NO_YIELDS_ENV);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.family, record.family);
    assert.match(r.json.error, expected);
    assert.equal(r.json.config, undefined);
  }
});

test('snapshot: with the RPC unreachable a single catalog match is still used', async (t) => {
  const { queue: _queue, ...noQueue } = BORING.contracts;
  const offChain = { ...BORING, chainId: 'stellar:pubnet' };
  const partial = { ...BORING, contracts: noQueue };
  for (const [record, expected] of [
    [offChain, /could not resolve an EVM chain id for this vault \(record chainId 'stellar:pubnet'\)/],
    [partial, /boring topology is not in the catalog for an unknown chain \(RPC unreachable\)/],
  ]) {
    const stub = await startYieldsStub([record]);
    t.after(stub.close);
    const r = raw(['snapshot', '--vault', BORING.contracts.vault, '--base-url', stub.url, '--rpc-url', 'http://127.0.0.1:9', '--timeout', '3000'], NO_YIELDS_ENV);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.json.error, expected);
  }
});

test('snapshot: bad --vault entries, --owner and explicit --base-url are usage errors', () => {
  const rpc = ['--rpc-url', 'http://127.0.0.1:9'];
  const bad = raw(['snapshot', '--vault', `${BORING.contracts.vault},nope`, ...rpc], NO_YIELDS_ENV);
  assert.equal(bad.code, 2);
  assert.match(bad.error.message, /--vault entries must be 0x addresses, got 'nope'/);
  assert.equal(raw(['snapshot', '--vault', BORING.contracts.vault, '--owner', '0x12', ...rpc], NO_YIELDS_ENV).code, 2);
  const base = raw(['snapshot', '--vault', BORING.contracts.vault, '--base-url', 'http://api.example.com', ...rpc], NO_YIELDS_ENV);
  assert.equal(base.code, 2);
  assert.match(base.error.message, /must be https/);
});

test('detect: family markers, no marker and RPC failure', async (t) => {
  const addr = (n) => `0x${String(n).repeat(40)}`;
  const stub = await startYieldsStub([], {
    code: {
      [addr(1)]: ['hook()'],
      [addr(2)]: ['asset()', 'lpTokenAddress()'],
      [addr(3)]: ['asset()', 'MORPHO()'],
      [addr(4)]: ['asset()', 'receiveSharesGate()'],
      [addr(5)]: ['asset()'],
      [addr(6)]: [],
    },
  });
  t.after(stub.close);
  const detect = (vault) => raw(['detect', '--vault', vault, '--rpc-url', stub.url, '--no-multicall'], NO_YIELDS_ENV);

  for (const [n, family] of [[1, 'boring'], [2, 'upshift_evm'], [3, 'morpho'], [4, 'morpho']]) {
    const r = detect(addr(n));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json, { vault: addr(n), family, next: `smart-yield ${family} --help` });
  }
  for (const n of [5, 6]) {
    const r = detect(addr(n));
    assert.equal(r.code, 3);
    assert.equal(r.error.code, 'NOT_FOUND');
    assert.match(r.error.hint, /lpTokenAddress/);
  }
  const rpc = detect(addr(7));
  assert.equal(rpc.code, 4);
  assert.equal(rpc.error.code, 'RPC_ERROR');
  assert.equal(rpc.error.retryable, true);
});

test('a read that returns no data is CONTRACT_ERROR, exit 6', async (t) => {
  const vault = '0x6666666666666666666666666666666666666666';
  const stub = await startYieldsStub([], { code: { [vault]: [] } });
  t.after(stub.close);
  const r = raw(['morpho', 'meta', '--vault', vault, '--rpc-url', stub.url, '--no-multicall'], NO_YIELDS_ENV);
  assert.equal(r.code, 6, r.stderr);
  assert.equal(r.error.code, 'CONTRACT_ERROR');
  assert.equal(r.error.retryable, false);
  assert.match(r.error.hint, /right contract/);
});

test('yields analytics: --days/--metric are forwarded, --summary and --last reshape series', async (t) => {
  const stub = await startYieldsStub();
  t.after(stub.close);
  const analytics = (...args) => raw(['yields', 'analytics', '--chain-id', 'eip155:1', '--address', MORPHO.contracts.vault, '--base-url', stub.url, ...args], NO_YIELDS_ENV);

  const full = analytics();
  assert.equal(full.code, 0, full.stderr);
  assert.deepEqual(full.json, STUB_ANALYTICS);

  const summary = analytics('--days', '3', '--summary');
  assert.equal(summary.code, 0, summary.stderr);
  assert.deepEqual(Object.keys(summary.json).sort(), ['apy', 'apy30d', 'apy7d', 'tvl', 'tvlUsd']);
  assert.deepEqual(summary.json.tvl, {
    points: 3, from: STUB_ANALYTICS.tvl[2][0], to: STUB_ANALYTICS.tvl[4][0], latest: 1300, min: 1050, max: 1300, mean: (1050 + 1200 + 1300) / 3,
  });

  const last = analytics('--metric', 'apy', '--last', '2');
  assert.equal(last.code, 0, last.stderr);
  assert.deepEqual(last.json, { apy: STUB_ANALYTICS.apy.slice(-2) });

  const lastSummary = analytics('--metric', 'tvl_usd', '--last', '1', '--summary');
  assert.deepEqual(lastSummary.json.tvlUsd, { points: 1, from: STUB_ANALYTICS.tvlUsd[4][0], to: STUB_ANALYTICS.tvlUsd[4][0], latest: 1301, min: 1301, max: 1301, mean: 1301 });

  const since = analytics('--since', '2026-10-06', '--metric', 'tvl');
  assert.deepEqual(since.json, { tvl: STUB_ANALYTICS.tvl.slice(-2) });

  const both = analytics('--days', '3', '--since', '2026-10-01');
  assert.equal(both.code, 2);
  assert.match(both.error.message, /--days is mutually exclusive with --since\/--until/);
  assert.equal(analytics('--last', 'x').code, 2);
  for (const bad of [['--last', '0'], ['--days', '0'], ['--days', 'abc'], ['--days', '36501'], ['--days', '100000000000000000000000'], ['--last', '100000000000000000000000']]) {
    // a dead API: the flag must be rejected before any request is made
    const r = raw(['yields', 'analytics', '--chain-id', 'eip155:1', '--address', MORPHO.contracts.vault, '--base-url', 'http://127.0.0.1:1', ...bad], NO_YIELDS_ENV);
    assert.equal(r.code, 2, `${bad.join(' ')}: ${r.stderr}`);
    assert.equal(r.error.code, 'USAGE');
  }
});

test('yields analytics: non-series values pass through --summary untouched', async (t) => {
  const path = `/vaults/${encodeURIComponent('eip155:1')}/${MORPHO.contracts.vault}/analytics`;
  const stub = await startYieldsStub(STUB_VAULTS, {
    routes: { [path]: { status: 200, body: { tvl: [], apy: STUB_ANALYTICS.apy, apy7d: [[1, 'x']] } } },
  });
  t.after(stub.close);
  const r = raw(['yields', 'analytics', '--chain-id', 'eip155:1', '--address', MORPHO.contracts.vault, '--base-url', stub.url, '--summary'], NO_YIELDS_ENV);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.tvl, []);
  assert.deepEqual(r.json.apy7d, [[1, 'x']]);
  assert.equal(r.json.apy.points, 5);

  const nullStub = await startYieldsStub(STUB_VAULTS, { routes: { [path]: { status: 200, body: null } } });
  t.after(nullStub.close);
  const nothing = raw(['yields', 'analytics', '--chain-id', 'eip155:1', '--address', MORPHO.contracts.vault, '--base-url', nullStub.url, '--summary'], NO_YIELDS_ENV);
  assert.equal(nothing.code, 0, nothing.stderr);
  assert.equal(nothing.stdout.trim(), 'null');
});

test('yields risk, balance, activity, positions and blockchains return the API payloads', async (t) => {
  const stub = await startYieldsStub();
  t.after(stub.close);
  const yields = (...args) => raw(['yields', ...args, '--base-url', stub.url], NO_YIELDS_ENV);
  const vaultArgs = ['--chain-id', 'eip155:1', '--address', MORPHO.contracts.vault];

  const risk = yields('risk', ...vaultArgs);
  assert.equal(risk.code, 0, risk.stderr);
  assert.equal(risk.json.chainId, 'eip155:1');
  assert.deepEqual(risk.json.indicators.map((i) => [i.key, i.status]), [['liquidity', 'ok'], ['oracle', 'error']]);

  const balance = yields('balance', ...vaultArgs, '--wallet', STUB_WALLET);
  assert.equal(balance.code, 0, balance.stderr);
  assert.equal(balance.json.liveSharesRaw, '1500000000');
  assert.equal(balance.json.apy30d, '0.0498');

  const activity = yields('activity', ...vaultArgs, '--wallet', STUB_WALLET);
  assert.equal(activity.code, 0, activity.stderr);
  assert.deepEqual(activity.json.map((a) => a.type), ['DEPOSIT', 'WITHDRAW_REQUEST']);
  assert.equal(activity.json[0].userAddress, STUB_WALLET);
  assert.equal(activity.json[0].vaultAddress, MORPHO.contracts.vault);

  const positions = yields('positions', '--wallet', STUB_WALLET);
  assert.equal(positions.code, 0, positions.stderr);
  assert.deepEqual(positions.json.map((p) => [p.name, p.withPositions]), [[MORPHO.name, true], ['Kamino Sentora PYUSD', false]]);
  assert.equal(positions.json[0].userMetrics.dbBalanceUsd, 1531.95);
  assert.equal(positions.json[1].userMetrics, null);

  const chains = yields('blockchains');
  assert.equal(chains.code, 0, chains.stderr);
  assert.deepEqual(chains.json, STUB_BLOCKCHAINS);
});

test('yields per-vault commands: unknown vault is NOT_FOUND, malformed inputs are usage errors', async (t) => {
  const stub = await startYieldsStub();
  t.after(stub.close);
  const yields = (...args) => raw(['yields', ...args, '--base-url', stub.url], NO_YIELDS_ENV);
  const missing = ['--chain-id', 'eip155:1', '--address', NOWHERE];
  for (const cmd of [['get'], ['analytics'], ['risk'], ['balance', '--wallet', STUB_WALLET], ['activity', '--wallet', STUB_WALLET]]) {
    const r = yields(...cmd, ...missing);
    assert.equal(r.code, 3, `${cmd[0]}: ${r.stderr}`);
    assert.equal(r.error.code, 'NOT_FOUND');
    assert.match(r.error.message, /not found/);
  }

  const badChain = yields('get', '--chain-id', 'eip155/1', '--address', MORPHO.contracts.vault);
  assert.equal(badChain.code, 2);
  assert.match(badChain.error.message, /--chain-id must be 1-64/);
  const badAddress = yields('get', '--chain-id', '1', '--address', 'not-an-address!');
  assert.equal(badAddress.code, 2);
  assert.match(badAddress.error.message, /--address must be a 0x EVM address/);
  assert.equal(yields('balance', '--chain-id', '1', '--address', MORPHO.contracts.vault, '--wallet', '0xnope').code, 2);
  assert.equal(yields('positions', '--wallet', 'G' + 'A'.repeat(55)).code, 0);
  assert.equal(raw(['yields', 'blockchains', '--base-url', 'not a url'], NO_YIELDS_ENV).code, 2);
});

test('positional arguments and a bare family are usage errors', () => {
  const positional = raw(['yields', 'list', 'extra']);
  assert.equal(positional.code, 2);
  assert.match(positional.error.hint, /All inputs are flags/);
  const bare = raw(['yields']);
  assert.equal(bare.code, 2);
  assert.match(bare.error.message, /Missing command for family 'yields'/);
  assert.match(bare.error.hint, /main-insights/);
});

test('snapshot --owner: a failing boring preflight read is an item error, not a crash', async (t) => {
  const stub = await startYieldsStub([BORING], { chainId: 57073 });
  t.after(stub.close);
  const r = raw(['snapshot', '--vault', BORING.contracts.vault, '--owner', STUB_WALLET, '--base-url', stub.url, '--rpc-url', stub.url, '--no-multicall'], NO_YIELDS_ENV);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.family, 'boring');
  assert.equal(r.json.config, undefined);
  assert.match(r.json.error, /eth_call/);
});
