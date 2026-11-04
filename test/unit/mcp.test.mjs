/**
 * No-network MCP server tests: real stdio JSON-RPC against the built bundle —
 * initialize handshake, generated tool surface, calls against a local API stub, and the
 * CliError taxonomy over MCP.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STUB_BLOCKCHAINS, STUB_VAULTS, startYieldsStub } from './yields-stub.mjs';

const MCP_BUNDLE = fileURLToPath(new URL('../../packages/vaults-mcp/dist/mcp.mjs', import.meta.url));
const MCP_SRC = fileURLToPath(new URL('../../packages/vaults-mcp/src/mcp.ts', import.meta.url));
const ARGV = process.env.NODE_V8_COVERAGE ? ['--import', 'tsx', MCP_SRC] : [MCP_BUNDLE];

/** pipeline an initialize handshake + requests, resolve with responses by id */
function mcp(requests, envOverride = {}) {
  const env = {
    ...process.env,
    VAULTS_RPC_URL: '', SENTORA_RPC_URL: '', ETH_RPC_URL: '',
    YIELDS_API_KEY: '', SENTORA_API_KEY: '', YIELDS_BASE_URL: '', SENTORA_API_URL: '',
    ...envOverride,
  };
  for (const k of Object.keys(env)) if (env[k] === '') delete env[k];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ARGV, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const wanted = new Set([0, ...requests.filter((r) => r.id !== undefined).map((r) => r.id)]);
    const responses = new Map();
    let buf = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`mcp timeout; responses so far: ${[...responses.keys()].join(',')}`));
    }, 30_000);
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined) responses.set(msg.id, msg);
      }
      if (responses.size >= wanted.size) {
        clearTimeout(timer);
        // EOF instead of a signal so the server exits cleanly and c8 gets its V8 coverage
        child.stdin.end();
        const force = setTimeout(() => child.kill(), 5_000);
        child.once('exit', () => { clearTimeout(force); resolve(responses); });
      }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    const messages = [
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      ...requests,
    ];
    child.stdin.write(messages.map((m) => JSON.stringify(m)).join('\n') + '\n');
  });
}

const toolError = (result) => JSON.parse(result.content[0].text).error;

test('mcp: initialize + generated tool surface mirrors the registry, read-only, no config flags', async () => {
  const responses = await mcp([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  const init = responses.get(0).result;
  assert.equal(init.serverInfo.name, 'smart-yield');
  assert.match(init.instructions, /MUST NOT be executed/);
  assert.match(init.instructions, /`available` \/ `required`/);

  const tools = responses.get(1).result.tools;
  const names = tools.map((t) => t.name);
  for (const expected of ['detect', 'snapshot', 'yields_list', 'yields_get', 'upshift_evm_plan_deposit', 'morpho_meta']) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  assert.ok(!names.includes('describe'), 'CLI-shaped describe must not be exposed over MCP');
  for (const tool of tools) {
    assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} must be readOnlyHint`);
    for (const banned of ['rpc-url', 'base-url', 'output', 'pretty', 'verbose', 'timeout', 'help']) {
      assert.ok(!(banned in tool.inputSchema.properties), `${tool.name} must not expose '${banned}'`);
    }
  }
  const get = tools.find((t) => t.name === 'yields_get');
  assert.deepEqual(get.inputSchema.required.sort(), ['address', 'chain-id']);
});

test('mcp: tools/call returns structuredContent from yields_list', async (t) => {
  const stub = await startYieldsStub();
  t.after(stub.close);
  const responses = await mcp([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'yields_list', arguments: { limit: '2', fields: 'name,family' } } },
  ], { YIELDS_BASE_URL: stub.url });
  const result = responses.get(1).result;
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent.total, STUB_VAULTS.length);
  assert.equal(result.structuredContent.returned, 2);
  assert.deepEqual(Object.keys(result.structuredContent.vaults[0]).sort(), ['family', 'name']);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
});

test('mcp: CliError taxonomy travels as tool errors', async () => {
  const responses = await mcp([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'morpho_meta', arguments: { vault: '0x000000000000000000000000000000000000dEaD' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'yields_list', arguments: { bogus: 'x' } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'yields_get', arguments: { 'chain-id': 1, address: '0x000000000000000000000000000000000000dEaD' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'yields_list', arguments: { toString: 'x' } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'yields_list', arguments: { hasOwnProperty: 'x' } } },
  ]);
  const noRpc = responses.get(1).result;
  assert.equal(noRpc.isError, true);
  assert.equal(toolError(noRpc).code, 'USAGE');
  assert.match(toolError(noRpc).hint, /VAULTS_RPC_URL/);

  const unknownArg = responses.get(2).result;
  assert.equal(unknownArg.isError, true);
  assert.match(toolError(unknownArg).message, /Unknown argument 'bogus'/);

  const wrongType = responses.get(3).result;
  assert.equal(wrongType.isError, true);
  assert.match(toolError(wrongType).message, /'chain-id' must be a string/);

  for (const [id, key] of [[4, 'toString'], [5, 'hasOwnProperty']]) {
    const inherited = responses.get(id).result;
    assert.equal(inherited.isError, true);
    assert.match(toolError(inherited).message, new RegExp(`Unknown argument '${key}'`));
  }
});

const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, ...(args !== undefined && { arguments: args }) } });

test('mcp: tool surface covers every yields command and the upshift_evm family', async () => {
  const responses = await mcp([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  const tools = responses.get(1).result.tools;
  const names = tools.map((t) => t.name);
  for (const expected of ['list', 'get', 'analytics', 'risk', 'main_insights', 'balance', 'activity', 'positions', 'blockchains']) {
    assert.ok(names.includes(`yields_${expected}`), `missing tool yields_${expected}`);
  }
  assert.ok(names.filter((n) => n.startsWith('upshift_evm_')).length >= 3, names.join(','));
  assert.ok(names.some((n) => n.startsWith('boring_')));
  assert.ok(names.every((n) => /^[a-z0-9_]+$/.test(n)), 'tool names must not contain dashes');

  const insights = tools.find((t) => t.name === 'yields_main_insights');
  assert.equal(insights.title, 'yields: main-insights');
  assert.deepEqual(insights.inputSchema.required.sort(), ['address', 'chain-id']);
  assert.equal(insights.inputSchema.additionalProperties, false);

  const chains = tools.find((t) => t.name === 'yields_blockchains');
  assert.deepEqual(chains.inputSchema.properties, {});
  assert.equal('required' in chains.inputSchema, false);
  assert.equal(tools.find((t) => t.name === 'yields_list').inputSchema.properties.featured.type, 'boolean');
  assert.equal(tools.find((t) => t.name === 'detect').title, 'detect');
});

test('mcp: yields_main_insights returns the market and maps upstream errors', async (t) => {
  const morpho = STUB_VAULTS.find((v) => v.family === 'morpho');
  const stub = await startYieldsStub();
  t.after(stub.close);
  const responses = await mcp([
    call(1, 'yields_main_insights', { 'chain-id': 'eip155:1', address: morpho.contracts.vault }),
    call(2, 'yields_main_insights', { 'chain-id': 'eip155:1', address: '0x0000000000000000000000000000000000000001' }),
    call(3, 'yields_main_insights', { 'chain-id': 'eip155:1' }),
  ], { YIELDS_BASE_URL: stub.url });

  const ok = responses.get(1).result;
  assert.notEqual(ok.isError, true);
  assert.deepEqual(ok.structuredContent.market, { blockchain: 'ethereum', protocol: 'morpho' });
  assert.equal(ok.structuredContent.metric.totalSupply, '412345678.123456');

  const missing = responses.get(2).result;
  assert.equal(missing.isError, true);
  assert.equal(toolError(missing).code, 'NOT_FOUND');
  assert.match(toolError(missing).message, /not found/);

  const noAddress = responses.get(3).result;
  assert.equal(noAddress.isError, true);
  assert.equal(toolError(noAddress).code, 'USAGE');
  assert.match(toolError(noAddress).message, /--address/);
});

test('mcp: array payloads, missing arguments, booleans, unknown tools and config flags', async (t) => {
  const stub = await startYieldsStub();
  t.after(stub.close);
  const responses = await mcp([
    call(1, 'yields_blockchains'),
    call(2, 'yields_list', { featured: true, fields: 'name' }),
    call(3, 'yields_lists', {}),
    call(4, 'yields_list', { 'base-url': 'https://attacker.example' }),
    call(5, 'yields_blockchains', { verbose: true }),
    call(6, 'yields_list', { featured: 'yes' }),
    call(7, 'detect', { vault: 'nothex' }),
  ], { YIELDS_BASE_URL: stub.url });

  const chains = responses.get(1).result;
  assert.notEqual(chains.isError, true);
  assert.deepEqual(chains.structuredContent, { result: STUB_BLOCKCHAINS });

  const featured = responses.get(2).result;
  assert.deepEqual(featured.structuredContent.vaults, [{ name: STUB_VAULTS.find((v) => v.featured === true).name }]);

  const unknownTool = responses.get(3).result;
  assert.equal(unknownTool.isError, true);
  assert.match(toolError(unknownTool).message, /Unknown tool 'yields_lists'/);
  assert.match(toolError(unknownTool).hint, /yields_list/);

  const baseUrl = responses.get(4).result;
  assert.equal(baseUrl.isError, true);
  assert.match(toolError(baseUrl).message, /Unknown argument 'base-url'/);

  const verbose = responses.get(5).result;
  assert.equal(verbose.isError, true);
  assert.equal(toolError(verbose).hint, 'Arguments: (none).');

  const wrongBool = responses.get(6).result;
  assert.equal(wrongBool.isError, true);
  assert.match(toolError(wrongBool).message, /'featured' must be a boolean, got string/);
  assert.equal(toolError(wrongBool).hint, undefined);

  const badVault = responses.get(7).result;
  assert.equal(badVault.isError, true);
  assert.equal(toolError(badVault).code, 'USAGE');
});
