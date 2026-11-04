import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STUB_ANALYTICS, STUB_BLOCKCHAINS, STUB_VAULTS, STUB_WALLET, startYieldsStub } from './yields-stub.mjs';

const SPEC_PATH = fileURLToPath(new URL('../../packages/yields-client/openapi.json', import.meta.url));
const TYPES_PATH = fileURLToPath(new URL('../../packages/yields-client/src/openapi.ts', import.meta.url));
const CLI = fileURLToPath(new URL('../../node_modules/openapi-typescript/bin/cli.js', import.meta.url));
const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));

function okSchema(path, method = 'get') {
  const schema = spec.paths[path]?.[method]?.responses?.['200']?.content?.['application/json']?.schema;
  assert.ok(schema, `spec has no 200 JSON response for ${method.toUpperCase()} ${path}`);
  return schema;
}

function undocumentedKeys(value, schema, at = '$') {
  if (value === null || value === undefined || typeof value !== 'object') return [];
  const variants = schema.oneOf ?? schema.anyOf;
  if (variants) {
    const results = variants.map((s) => undocumentedKeys(value, s, at));
    return results.find((r) => r.length === 0) ?? results.flat();
  }
  if (Array.isArray(value)) {
    if (schema.type !== 'array') return schema.type === undefined ? [] : [`${at} (array, spec says ${schema.type})`];
    return value.flatMap((v, i) => undocumentedKeys(v, schema.items ?? {}, `${at}[${i}]`));
  }
  if (schema.type !== undefined && schema.type !== 'object') return [`${at} (object, spec says ${schema.type})`];
  const props = schema.properties ?? {};
  const extra = schema.additionalProperties;
  return Object.entries(value).flatMap(([k, v]) => {
    if (Object.hasOwn(props, k)) return undocumentedKeys(v, props[k], `${at}.${k}`);
    if (typeof extra === 'object' && extra !== null) return undocumentedKeys(v, extra, `${at}.${k}`);
    if (extra === true || (schema.properties === undefined && schema.type === undefined)) return [];
    return [`${at}.${k}`];
  });
}

test('src/openapi.ts matches what openapi-typescript generates from openapi.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yields-openapi-'));
  try {
    const out = join(dir, 'openapi.ts');
    const r = spawnSync(process.execPath, [CLI, SPEC_PATH, '-o', out], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const lf = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    assert.equal(lf(TYPES_PATH), lf(out), 'run `npm run openapi:types` and commit the result');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the key walker flags keys the spec does not document', () => {
  assert.deepEqual(undocumentedKeys([{ ...STUB_BLOCKCHAINS[0], bogus: 1 }], okSchema('/blockchains')), ['$[0].bogus']);
  assert.deepEqual(undocumentedKeys([{ ...STUB_VAULTS[0], contracts: { vault: '0x', x: '1' } }], okSchema('/vaults')), ['$[0].contracts.x']);
});

test('stub fixtures only use keys the spec documents', () => {
  assert.deepEqual(undocumentedKeys(STUB_VAULTS, okSchema('/vaults')), []);
  assert.deepEqual(undocumentedKeys(STUB_BLOCKCHAINS, okSchema('/blockchains')), []);
  assert.deepEqual(undocumentedKeys(STUB_ANALYTICS, okSchema('/vaults/{chainId}/{address}/analytics')), []);
});

test('every stub route only answers with keys the spec documents', async () => {
  const stub = await startYieldsStub();
  try {
    const direct = STUB_VAULTS.find((v) => v.type === 'direct');
    const vault = `/vaults/${direct.chainId}/${direct.contracts.vault}`;
    const routes = [
      ['/vaults', '/vaults'],
      ['/blockchains', '/blockchains'],
      [`/users/${STUB_WALLET}/positions`, '/users/{wallet}/positions'],
      [vault, '/vaults/{chainId}/{address}'],
      [`${vault}/main-insights`, '/vaults/{chainId}/{address}/main-insights'],
      [`${vault}/analytics`, '/vaults/{chainId}/{address}/analytics'],
      [`${vault}/risk-indicators`, '/vaults/{chainId}/{address}/risk-indicators'],
      [`${vault}/users/${STUB_WALLET}/balance`, '/vaults/{chainId}/{address}/users/{wallet}/balance'],
      [`${vault}/users/${STUB_WALLET}/activity`, '/vaults/{chainId}/{address}/users/{wallet}/activity'],
    ];
    for (const [url, specPath] of routes) {
      const res = await fetch(stub.url + url);
      assert.equal(res.status, 200, url);
      assert.deepEqual(undocumentedKeys(await res.json(), okSchema(specPath)), [], url);
    }
  } finally {
    stub.close();
  }
});
