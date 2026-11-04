#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 120_000;

const USAGE = `Usage: node scripts/publish.mjs [package-dir] [options]

Publishes one workspace package. Prompts for anything not given as an argument.
By default the package is published under its own name; give a scope to
rescope it. Source files are never modified: the package is built and packed
in place, then the tarball is rewritten in a temp directory and published
from there.

Mode is auto-detected from the registry:
  first publish  -> npm publish --access public (interactive login, offered
                    automatically via a temporary userconfig)
  later releases -> npm stage publish (needs NPM_TOKEN in the environment)

Options:
  --scope <scope>    e.g. --scope myscope (leading @ optional)
  --tag <tag>        npm dist-tag, e.g. --tag alpha (default: latest)
  --dry-run          run npm publish --dry-run and stop before mutating the registry;
                     skips npm ci, so it packs whatever node_modules holds
  --yes              skip the confirmation prompt
  -h, --help         show this help`;

function fail(message, code = 1) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

const LONG_NPM_TIMEOUT_MS = 10 * 60_000;
const EXIT_TRANSIENT = 75;

function npm(argv, opts = {}) {
  // built per call: NPM_CONFIG_USERCONFIG is set later for the first-publish login
  const { NPM_TOKEN: _token, ...envWithoutToken } = process.env;
  const res = spawnSync('npm', argv, {
    cwd: opts.cwd ?? ROOT,
    shell: true,
    encoding: 'utf8',
    timeout: opts.timeout ?? (opts.inherit ? undefined : TIMEOUT_MS),
    stdio: opts.inherit ? 'inherit' : 'pipe',
    env: opts.withToken ? process.env : envWithoutToken,
  });
  if (res.error) return { status: -1, stdout: '', stderr: String(res.error) };
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean' },
      scope: { type: 'string' },
      tag: { type: 'string' },
    },
  });
} catch (err) {
  fail(`${err.message}\n\n${USAGE}`, 2);
}
if (parsed.values.help) { console.log(USAGE); process.exit(0); }
if (parsed.positionals.length > 1) fail(`unexpected argument ${parsed.positionals[1]}\n\n${USAGE}`, 2);
const args = {
  scope: parsed.values.scope ?? null,
  tag: parsed.values.tag ?? null,
  dryRun: parsed.values['dry-run'] ?? false,
  yes: parsed.values.yes ?? false,
  pkg: parsed.positionals[0] ?? null,
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const packages = readdirSync(path.join(ROOT, 'packages'))
  .filter((d) => existsSync(path.join(ROOT, 'packages', d, 'package.json')));
const workspaceVersions = new Map(packages.map((d) => {
  const p = JSON.parse(readFileSync(path.join(ROOT, 'packages', d, 'package.json'), 'utf8'));
  return [p.name, p.version];
}));

if (!args.pkg) {
  packages.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
  const answer = (await rl.question('Package to publish (number or name): ')).trim();
  args.pkg = /^\d+$/.test(answer) ? packages[Number(answer) - 1] : answer;
}
if (!packages.includes(args.pkg)) fail(`unknown package "${args.pkg}". Available: ${packages.join(', ')}`);

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'packages', args.pkg, 'package.json'), 'utf8'));
const baseName = pkg.name.split('/').pop();

if (args.scope === null) {
  const answer = (await rl.question(`Scope [enter = keep ${pkg.name.split('/')[0]}]: `)).trim();
  if (answer) args.scope = answer;
}
if (args.scope !== null) {
  if (!/^@?[a-z0-9][a-z0-9._-]*$/.test(args.scope)) fail(`invalid scope "${args.scope}"`, 2);
  if (!args.scope.startsWith('@')) args.scope = `@${args.scope}`;
}

const targetName = args.scope ? `${args.scope}/${baseName}` : pkg.name;
const version = pkg.version;

const prerelease = version.includes('-') ? version.split('-')[1].split('.')[0] : null;
if (args.tag === null && prerelease) {
  const answer = (await rl.question(`Version ${version} is a prerelease; dist-tag [${prerelease}]: `)).trim();
  args.tag = answer || prerelease;
}
if (args.tag !== null && !/^[a-z][a-z0-9._-]*$/i.test(args.tag)) fail(`invalid --tag "${args.tag}"`, 2);
const tagFlag = args.tag ? ['--tag', args.tag] : [];

console.log(`Checking registry for ${targetName}...`);
const view = npm(['view', targetName, 'version', '--json']);
let publishedVersion = null;
if (view.status === 0) {
  publishedVersion = JSON.parse(view.stdout.trim());
} else if (!/E404|404 Not Found/i.test(view.stderr + view.stdout)) {
  fail(`could not query registry for ${targetName}:\n${view.stderr.trim()}`);
}
const mode = publishedVersion === null ? 'publish' : 'stage';

if (publishedVersion === version) {
  console.log(`${targetName}@${version} is already published; bump the version in packages/${args.pkg}/package.json to release.`);
  process.exit(0);
}

if (!args.dryRun && mode === 'stage') {
  const probe = npm(['stage']);
  if (/Unknown command/i.test(probe.stderr + probe.stdout)) {
    const npmVersion = npm(['--version']).stdout.trim();
    fail(`this npm (${npmVersion}) has no 'npm stage' command; upgrade npm (npm install -g npm@latest)`);
  }
  if (!process.env.NPM_TOKEN) {
    fail('NPM_TOKEN is not set (required to stage); set it in the environment (e.g. from your secret manager) and rerun');
  }
}

if (!args.dryRun) {
  const git = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8', timeout: TIMEOUT_MS });
  if (git.status !== 0) fail(`git status failed:\n${(git.stderr ?? String(git.error)).trim()}`);
  if (git.stdout.trim()) {
    fail(`working tree is dirty; commit or stash first so the release is reproducible from a commit:\n${git.stdout.trim()}`);
  }
}

const action = args.dryRun ? 'dry-run' : mode === 'publish' ? 'first publish (direct)' : 'stage for approval';
if (!args.yes && !args.dryRun) {
  const answer = (await rl.question(`${action}: ${targetName}@${version} — continue? [y/N] `)).trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes') { console.log('Aborted.'); process.exit(0); }
}
rl.close();

// a stale node_modules would bundle whatever versions it holds, not the lockfile's
if (args.dryRun) {
  console.log('dry-run: skipping npm ci, the build uses the current node_modules');
} else {
  // --ignore-scripts: the token stays readable in this process's environment, so dependency install scripts must not run
  const ci = npm(['ci', '--include=dev', '--ignore-scripts'], { inherit: true, timeout: LONG_NPM_TIMEOUT_MS });
  if (ci.status !== 0) {
    const timedOut = /ETIMEDOUT/.test(ci.stderr);
    fail(
      `npm ci ${timedOut ? `timed out after ${LONG_NPM_TIMEOUT_MS / 60_000} minutes` : 'failed'}; node_modules may be incomplete. Rerun this publish command, which reinstalls first.`,
      timedOut ? EXIT_TRANSIENT : 1,
    );
  }
}
if (npm(['run', 'build', '--workspace', `packages/${args.pkg}`, '--if-present'], { inherit: true }).status !== 0) {
  fail(`build failed for packages/${args.pkg}`);
}

for (const stale of readdirSync(os.tmpdir()).filter((d) => d.startsWith('smart-yield-publish-'))) {
  rmSync(path.join(os.tmpdir(), stale), { recursive: true, force: true });
}

const stagingDir = mkdtempSync(path.join(os.tmpdir(), `smart-yield-publish-${args.pkg}-`));
let result = null;

class Bail extends Error {}
const bail = (message) => { throw new Bail(message); };

try {
  const packRes = npm(['pack', '--workspace', `packages/${args.pkg}`, '--pack-destination', stagingDir, '--json']);
  if (packRes.status !== 0) bail(`npm pack failed:\n${packRes.stderr.trim()}`);
  const tarball = path.join(stagingDir, JSON.parse(packRes.stdout)[0].filename);

  const tarRes = spawnSync('tar', ['-xzf', tarball, '-C', stagingDir], { encoding: 'utf8', timeout: TIMEOUT_MS });
  if (tarRes.status !== 0) bail(`failed to extract ${tarball}:\n${tarRes.stderr}`);
  const publishDir = path.join(stagingDir, 'package');

  const publishPkgPath = path.join(publishDir, 'package.json');
  const publishPkg = JSON.parse(readFileSync(publishPkgPath, 'utf8'));
  publishPkg.name = targetName;
  delete publishPkg.scripts;
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const dep of Object.keys(publishPkg[field] ?? {})) {
      if (workspaceVersions.has(dep) && args.scope) {
        const renamed = `${args.scope}/${dep.split('/').pop()}`;
        publishPkg[field][renamed] = `^${workspaceVersions.get(dep)}`;
        delete publishPkg[field][dep];
      }
    }
  }
  writeFileSync(publishPkgPath, `${JSON.stringify(publishPkg, null, 2)}\n`);

  if (args.scope) {
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const file of readdirSync(publishDir, { recursive: true })) {
      const isCode = /\.(m?js|cjs|ts)$/.test(file);
      if (!isCode && !file.endsWith('.md')) continue;
      const full = path.join(publishDir, file);
      let text = readFileSync(full, 'utf8');
      for (const dep of workspaceVersions.keys()) {
        const renamed = `${args.scope}/${dep.split('/').pop()}`;
        text = isCode
          ? text.replace(new RegExp(`(['"])${escapeRe(dep)}(?=['"/])`, 'g'), `$1${renamed}`)
          : text.replace(new RegExp(`${escapeRe(dep)}(?![\\w-])`, 'g'), renamed);
      }
      writeFileSync(full, text);
    }
  }

  // files excludes the source maps, so drop the comments that would point at them
  for (const file of readdirSync(publishDir, { recursive: true })) {
    if (!/\.(m?js|cjs)$/.test(file)) continue;
    const full = path.join(publishDir, file);
    const code = readFileSync(full, 'utf8');
    const stripped = code.replace(/\n\/\/# sourceMappingURL=(\S+)\s*$/, (line, map) =>
      (existsSync(path.join(path.dirname(full), map)) ? line : '\n'));
    if (stripped !== code) writeFileSync(full, stripped);
  }

  if (args.dryRun) {
    if (npm(['publish', '--dry-run', '--access', 'public', ...tagFlag], { cwd: publishDir, inherit: true }).status !== 0) {
      bail('npm publish --dry-run failed');
    }
    result = { status: 'dry-run', name: targetName, version };
  } else if (mode === 'publish') {
    let tempUserconfig = null;
    if (!process.env.NPM_CONFIG_USERCONFIG) {
      tempUserconfig = path.join(stagingDir, 'npmrc-login');
      process.env.NPM_CONFIG_USERCONFIG = tempUserconfig;
      console.log('First publish needs a login (kept in a temporary userconfig, not ~/.npmrc):');
      if (npm(['login'], { cwd: publishDir, inherit: true }).status !== 0) bail('npm login failed');
    } else if (npm(['whoami'], { cwd: publishDir }).status !== 0) {
      bail(`not logged in under NPM_CONFIG_USERCONFIG (${process.env.NPM_CONFIG_USERCONFIG}). Run 'npm login' there first.`);
    }
    try {
      if (npm(['publish', '--access', 'public', ...tagFlag], { cwd: publishDir, inherit: true }).status !== 0) {
        bail(`npm publish failed for ${targetName}@${version}`);
      }
    } finally {
      if (tempUserconfig) delete process.env.NPM_CONFIG_USERCONFIG;
    }
    result = { status: 'published', name: targetName, version };
  } else {
    writeFileSync(path.join(publishDir, '.npmrc'), '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n');
    const staged = npm(['stage', 'publish', ...tagFlag], { cwd: publishDir, inherit: true, withToken: true, timeout: LONG_NPM_TIMEOUT_MS });
    if (staged.status !== 0 && /ETIMEDOUT/.test(staged.stderr)) {
      bail(`npm stage publish timed out after ${LONG_NPM_TIMEOUT_MS / 60_000} minutes for ${targetName}@${version}; it may already be staged. Check 'npm stage list' before rerunning.`);
    }
    if (staged.status !== 0) bail(`npm stage publish failed for ${targetName}@${version}`);
    result = {
      status: 'staged', name: targetName, version,
      next: 'npm stage list && npm stage approve <stage-id> (2FA, publish-capable login required)',
    };
  }
} catch (err) {
  if (!(err instanceof Bail)) throw err;
  result = { error: err.message };
} finally {
  rmSync(stagingDir, { recursive: true, force: true });
}

if (result?.error) fail(result.error);
console.log(`${result.status}: ${result.name}@${result.version}`);
if (result.next) console.log(`next: ${result.next}`);
