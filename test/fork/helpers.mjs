/**
 * Shared plumbing for the fork suite. Tests drive the built CLI
 * (packages/vaults-cli/dist/cli.mjs) against a local anvil fork and execute
 * the returned plan steps from impersonated accounts.
 *
 * Prereq: anvil --fork-url $ETH_RPC_URL --chain-id 1   (default: 127.0.0.1:8545)
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseUnits } from 'viem';

export const RPC = process.env.FORK_RPC_URL ?? 'http://127.0.0.1:8545';

const CLI_BUNDLE = fileURLToPath(new URL('../../packages/vaults-cli/dist/cli.mjs', import.meta.url));
const CLI_SRC = fileURLToPath(new URL('../../packages/vaults-cli/src/cli.ts', import.meta.url));

/**
 * Under c8 (NODE_V8_COVERAGE is inherited), run the CLI from TS sources via tsx
 * so V8 sees one script per module — coverage over the single-file bundle remaps
 * to bogus whole-file credit. Normal runs execute the shipped bundle.
 */
const CLI_ARGV = process.env.NODE_V8_COVERAGE ? ['--import', 'tsx', CLI_SRC] : [CLI_BUNDLE];

export const pc = createPublicClient({ transport: http(RPC) });
export const rpc = (method, params = []) => pc.request({ method, params });

// whatever chain the fork serves — built lazily so tests work on any chain
let forkChainDef;
async function forkChain() {
  if (!forkChainDef) {
    const id = await pc.getChainId();
    forkChainDef = defineChain({
      id,
      name: `fork-${id}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [RPC] } },
    });
  }
  return forkChainDef;
}

export const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address, uint256) returns (bool)',
]);

// Large, stable USDC holders — findUsdcWhale picks the first with balance.
export const WHALES = [
  '0x37305B1cD40574E4C5Ce33f8e8306Be057fD7341', // Circle
  '0x28C6c06298d514Db089934071355E5743bf21d60', // Binance 14
  '0x55FE002aefF02F77364de339a1292923A15844B8', // Circle 2
];

/** Run the CLI against the fork; returns exit code plus parsed stdout/stderr. */
export function cli(...args) {
  const res = spawnSync(process.execPath, [...CLI_ARGV, ...args, '--rpc-url', RPC], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  let json;
  try { json = JSON.parse(res.stdout); } catch { /* non-JSON output (help text) */ }
  let error;
  try { error = JSON.parse(res.stderr)?.error; } catch { /* non-JSON stderr */ }
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, json, error };
}

// callers must fail on `error`, not skip: a skipped suite reads as green
export function yieldsCatalog(...filters) {
  const r = cli('yields', 'list', ...filters);
  if (r.code === 0 && Array.isArray(r.json?.vaults)) return { vaults: r.json.vaults };
  const api = process.env.YIELDS_BASE_URL || process.env.SENTORA_API_URL || 'the default production API';
  const cause = r.error ? `${r.error.code}: ${r.error.message}` : `exit ${r.code}: ${String(r.stderr).trim().slice(0, 300)}`;
  return {
    error:
      `vault discovery via 'yields list' against ${api} failed (${cause}). ` +
      'Point YIELDS_BASE_URL (and YIELDS_API_KEY if it needs one) at a Sentora yields API ' +
      'environment that serves the schemaVersion 1 vault catalog.',
  };
}

export async function ensureAnvil() {
  if (!process.env.NODE_V8_COVERAGE && !existsSync(CLI_BUNDLE)) {
    throw new Error(`CLI bundle missing at ${CLI_BUNDLE} — run: npm run build`);
  }
  try {
    await rpc('anvil_impersonateAccount', [WHALES[0]]);
  } catch {
    throw new Error(
      `anvil not reachable at ${RPC} — start it with: anvil --fork-url $ETH_RPC_URL --chain-id 1` +
      ' (or set FORK_RPC_URL)',
    );
  }
}

export const snapshot = () => rpc('evm_snapshot');
export const revert = (id) => rpc('evm_revert', [id]);
const { evmChainId } = await import('../../packages/yields-client/dist/index.js').catch(() => {
  throw new Error('packages/yields-client/dist is missing: run npm run build before the fork tests');
});
export const evmChain = (chainId) => evmChainId(String(chainId))?.toString();

export async function findUsdcWhale(min = parseUnits('100000', 6)) {
  for (const w of WHALES) {
    const bal = await pc.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [w] });
    if (bal > min) return w;
  }
  throw new Error('No funded USDC whale found on this fork — update WHALES in test/fork/helpers.mjs.');
}

/** Sign & send a plan's steps[] sequentially from an impersonated account. */
export async function executeSteps(steps, from) {
  await rpc('anvil_impersonateAccount', [from]);
  await rpc('anvil_setBalance', [from, '0x8AC7230489E80000']); // 10 ETH for gas
  const wc = createWalletClient({ account: from, chain: await forkChain(), transport: http(RPC) });
  const hashes = [];
  for (const step of steps) {
    const hash = await wc.sendTransaction({ to: step.to, data: step.data, value: BigInt(step.value) });
    await pc.waitForTransactionReceipt({ hash });
    hashes.push(hash);
  }
  return hashes;
}
