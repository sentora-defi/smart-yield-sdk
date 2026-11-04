import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeThirdPartyNotices } from '../../scripts/third-party-notices.mjs';

const ROOT = new URL('../../', import.meta.url);

function publishablePackages() {
  return readdirSync(new URL('packages/', ROOT))
    .filter((dir) => existsSync(new URL(`packages/${dir}/package.json`, ROOT)))
    .map((dir) => ({ dir, pkg: JSON.parse(readFileSync(new URL(`packages/${dir}/package.json`, ROOT), 'utf8')) }))
    .filter(({ pkg }) => !pkg.private);
}

function noticeHeadings(text) {
  let fence;
  return text.split('\n').filter((l) => {
    const ticks = /^`{4,}/.exec(l)?.[0];
    if (fence === undefined && ticks) fence = ticks;
    else if (fence !== undefined && l === fence) fence = undefined;
    else return fence === undefined && l.startsWith('## ');
    return false;
  }).map((l) => l.slice(3));
}

test('every publishable package ships the root LICENSE and declares MIT', () => {
  const rootLicense = readFileSync(new URL('LICENSE', ROOT), 'utf8');
  for (const { dir, pkg } of publishablePackages()) {
    assert.equal(pkg.license, 'MIT', dir);
    const license = new URL(`packages/${dir}/LICENSE`, ROOT);
    assert.ok(existsSync(license), `${dir}: missing LICENSE`);
    assert.equal(readFileSync(license, 'utf8'), rootLicense, dir);
  }
});

test('the bundled cli and mcp need node 20.3, the libraries node 20, and bin paths are in the form npm keeps', () => {
  for (const { dir, pkg } of publishablePackages()) {
    assert.equal(pkg.engines?.node, pkg.bin ? '>=20.3.0' : '>=20', dir);
    const targets = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin ?? {});
    for (const target of targets) assert.ok(!target.startsWith('./'), `${dir}: npm publish drops bin paths starting with ./`);
  }
});

test('the cli and mcp bundles ship the notices of the packages they inline', () => {
  for (const [dir, mustList] of [['vaults-cli', ['viem']], ['vaults-mcp', ['viem', '@modelcontextprotocol/sdk', 'fast-uri']]]) {
    const headings = noticeHeadings(readFileSync(new URL(`packages/${dir}/dist/THIRD_PARTY_NOTICES.md`, ROOT), 'utf8'));
    for (const name of mustList) assert.ok(headings.some((h) => h.startsWith(`${name}@`)), `${dir}: ${name}`);
    assert.ok(!headings.some((h) => h.startsWith('@sentora/')), dir);
    assert.equal(new Set(headings).size, headings.length, `${dir}: duplicate sections`);
  }
});

test('notices keep two versions of a package, fence markdown license text and skip non-license files', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'notices-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = (rel, json, files) => {
    const dir = path.join(root, rel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify(json));
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  };
  pkg('node_modules/dupe', { name: 'dupe', version: '1.0.0', license: 'MIT' }, { LICENSE: 'MIT v1' });
  pkg('node_modules/x/node_modules/dupe', { name: 'dupe', version: '2.0.0', license: '(MIT OR Apache-2.0)' }, { 'LICENSE-MIT': 'MIT v2', NOTICE: 'notice v2' });
  pkg('node_modules/md', { name: 'md', version: '1.0.0', licenses: [{ type: 'BlueOak-1.0.0' }] }, {
    'LICENSE.md': '# Blue Oak\n\n````\n## Injected\n````',
    'license.js': 'SOURCE_CODE_MARKER',
    'LICENSE-APACHE-2.0': 'apache text',
  });
  pkg('node_modules/linked', { name: 'linked', version: '1.0.0', license: 'MIT' }, { 'real-text': 'linked text' });
  symlinkSync('real-text', path.join(root, 'node_modules/linked/LICENSE'));
  mkdirSync(path.join(root, 'node_modules/linked/NOTICE-dir'));
  const input = (p) => ({ [p]: { bytesInOutput: 1 } });
  const metafile = { outputs: { 'out.js': { inputs: {
    ...input('node_modules/dupe/index.js'), ...input('node_modules/x/node_modules/dupe/index.js'),
    ...input('node_modules/md/index.js'), ...input('node_modules/linked/index.js'),
    'node_modules/unused/index.js': { bytesInOutput: 0 },
  } } } };
  writeThirdPartyNotices(metafile, root, 'NOTICES.md');
  const text = readFileSync(path.join(root, 'NOTICES.md'), 'utf8');
  assert.deepEqual(noticeHeadings(text), ['dupe@1.0.0', 'dupe@2.0.0', 'linked@1.0.0', 'md@1.0.0']);
  assert.match(text, /License: \(MIT OR Apache-2\.0\)\n/);
  assert.match(text, /License: BlueOak-1\.0\.0\n/);
  assert.match(text, /MIT v2\n\nnotice v2/);
  assert.match(text, /apache text/);
  assert.match(text, /linked text/);
  assert.doesNotMatch(text, /SOURCE_CODE_MARKER/);

  pkg('node_modules/bare', { name: 'bare', version: '1.0.0', license: 'MIT' }, { NOTICE: 'only a notice' });
  assert.throws(() => writeThirdPartyNotices({ outputs: { 'out.js': { inputs: input('node_modules/bare/index.js') } } }, root, 'X.md'), /bare@1\.0\.0 is bundled but ships no license file/);
});
