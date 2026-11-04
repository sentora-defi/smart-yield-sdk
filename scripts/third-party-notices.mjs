import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const LEGAL_FILE = /^((un)?licen[cs]e|copying|notice|[a-z0-9]+-licen[cs]e)([-._][a-z0-9.-]*)?$/i;
const CODE_FILE = /\.([cm]?[jt]sx?|json|map)$/i;

function packageRoot(input) {
  const parts = input.split('/');
  const at = parts.lastIndexOf('node_modules');
  if (at === -1) return undefined;
  const nameParts = parts[at + 1]?.startsWith('@') ? 2 : 1;
  return parts.slice(0, at + 1 + nameParts).join('/');
}

function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  const types = [pkg.license, ...(Array.isArray(pkg.licenses) ? pkg.licenses : [])]
    .map((l) => (typeof l === 'object' && l !== null ? l.type : undefined))
    .filter((t) => typeof t === 'string');
  return types.length ? types.join(' OR ') : 'see license text';
}

function fenced(text) {
  const longest = Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

export function writeThirdPartyNotices(metafile, cwd, outFile) {
  const roots = new Set();
  for (const output of Object.values(metafile.outputs)) {
    for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
      const root = bytesInOutput > 0 ? packageRoot(input) : undefined;
      if (root) roots.add(path.resolve(cwd, root));
    }
  }
  const packages = new Map();
  for (const dir of roots) {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const id = `${pkg.name}@${pkg.version}`;
    if (packages.has(id)) continue;
    const files = readdirSync(dir)
      .filter((f) => LEGAL_FILE.test(f) && !CODE_FILE.test(f) && statSync(path.join(dir, f)).isFile())
      .sort();
    if (!files.some((f) => !/^notice/i.test(f))) throw new Error(`${id} is bundled but ships no license file`);
    const text = files.map((f) => readFileSync(path.join(dir, f), 'utf8').trim()).join('\n\n');
    packages.set(id, { id, license: licenseOf(pkg), text });
  }
  const body = [...packages.values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p) => `## ${p.id}\n\nLicense: ${p.license}\n\n${fenced(p.text)}\n`)
    .join('\n');
  writeFileSync(path.resolve(cwd, outFile), `# Third-party notices\n\nThis bundle includes the following packages.\n\n${body}`);
}
