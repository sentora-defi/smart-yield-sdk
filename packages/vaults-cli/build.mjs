import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { writeThirdPartyNotices } from '../../scripts/third-party-notices.mjs';

const versionOf = (pkgJsonUrl) =>
  JSON.parse(readFileSync(new URL(pkgJsonUrl, import.meta.url), 'utf8')).version;

const result = await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  conditions: ['sentora-source'],
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/cli.mjs',
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: true, // lets c8 attribute fork-suite coverage back to package sources
  logLevel: 'info',
  metafile: true,
  define: {
    __VAULTS_CLI_VERSION__: JSON.stringify(versionOf('./package.json')),
    __YIELDS_CLIENT_VERSION__: JSON.stringify(versionOf('../yields-client/package.json')),
  },
});

writeThirdPartyNotices(result.metafile, process.cwd(), 'dist/THIRD_PARTY_NOTICES.md');
