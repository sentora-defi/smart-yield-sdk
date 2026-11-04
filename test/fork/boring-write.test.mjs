/**
 * Write-path suite for the boring family on an Ink fork (chain 57073):
 *
 *   anvil --fork-url https://rpc-gel.inkonchain.com --chain-id 57073
 *
 * Impersonates a large holder of the vault's deposit token (discovered live
 * via Ink's Blockscout token-holders API), then: plan-deposit → execute →
 * assert minted shares, plan-withdraw → execute (approve shares to queue +
 * request) → assert escrow. Vault + topology come from the catalog (`yields list` against
 * YIELDS_BASE_URL, default production); a failed discovery fails the suite.
 */
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseAbi } from 'viem';
import { cli, ensureAnvil, evmChain, snapshot, revert, executeSteps, pc, yieldsCatalog } from './helpers.mjs';

const forkChain = await pc.getChainId().catch(() => null);

const catalog = yieldsCatalog('--family', 'boring');
const withQueue = (catalog.vaults ?? []).filter((v) => v.contracts?.queue && v.depositToken?.address);
const record = withQueue.find((v) => forkChain !== null && evmChain(v.chainId) === String(forkChain)) ?? withQueue[0];

const skip = catalog.error
  ? false
  : !record
    ? 'catalog has no boring vault with both contracts.queue and depositToken'
    : forkChain !== null && String(forkChain) !== evmChain(record.chainId)
      ? `vault is on chain ${record.chainId}, fork is chain ${forkChain}`
      : false;
const live = !skip && !catalog.error;

const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);
const queueAbi = parseAbi(['function getRequestIds() view returns (bytes32[])']);

let whale;
let amount;
let snapId;

async function findAssetWhale(asset, min) {
  const res = await fetch(`https://explorer.inkonchain.com/api/v2/tokens/${asset}/holders`, {
    signal: AbortSignal.timeout(30_000),
  });
  const { items } = await res.json();
  for (const item of items ?? []) {
    const addr = item.address?.hash ?? item.address_hash;
    if (!addr) continue;
    const bal = await pc.readContract({ address: asset, abi: erc20, functionName: 'balanceOf', args: [addr] });
    if (bal >= min) return { addr, bal };
  }
  throw new Error(`No funded ${asset} holder found via Ink Blockscout — update the whale lookup.`);
}

before(async () => {
  await ensureAnvil();
  if (!live) return;
  const asset = record.depositToken.address;
  const unit = 10n ** BigInt(await pc.readContract({ address: asset, abi: erc20, functionName: 'decimals' }));
  const holder = await findAssetWhale(asset, unit);
  whale = holder.addr;
  const tenth = holder.bal / 10n;
  amount = tenth < 100n * unit ? tenth : 100n * unit;
});
beforeEach(async () => { if (live) snapId = await snapshot(); });
afterEach(async () => { if (live) await revert(snapId); });

function shares(owner) {
  const r = cli(
    'boring', 'position', '--vault', record.contracts.vault, '--asset', record.depositToken.address,
    '--owner', owner, '--queue', record.contracts.queue,
  );
  assert.equal(r.code, 0, r.stderr);
  return BigInt(r.json.shares);
}

test(`boring write path: teller deposit mints expected shares (${record?.name ?? 'unavailable'})`, { skip }, async (t) => {
  if (catalog.error) assert.fail(catalog.error);
  const plan = cli(
    'boring', 'plan-deposit', '--vault', record.contracts.vault, '--asset', record.depositToken.address,
    '--amount', String(amount), '--owner', whale, '--queue', record.contracts.queue,
  );
  assert.equal(plan.code, 0, plan.stderr || plan.stdout);
  assert.equal(plan.json.blockers.length, 0);

  const before_ = shares(whale);
  await executeSteps(plan.json.steps, whale);
  const minted = shares(whale) - before_;
  assert.equal(minted, BigInt(plan.json.expected.shares));
  assert.ok(minted >= BigInt(plan.json.expected.minimumMint), 'minted must respect the slippage floor');
  t.diagnostic(`teller deposit minted ${minted} shares (minimumMint ${plan.json.expected.minimumMint})`);
});

test('boring write path: queued withdrawal escrows shares to the queue', { skip }, async (t) => {
  if (catalog.error) assert.fail(catalog.error);
  const dep = cli(
    'boring', 'plan-deposit', '--vault', record.contracts.vault, '--asset', record.depositToken.address,
    '--amount', String(amount), '--owner', whale, '--queue', record.contracts.queue,
  );
  assert.equal(dep.code, 0, dep.stderr || dep.stdout);
  await executeSteps(dep.json.steps, whale);
  const owned = shares(whale);
  const half = owned / 2n;

  const plan = cli(
    'boring', 'plan-withdraw', '--vault', record.contracts.vault, '--asset-out', record.depositToken.address,
    '--shares', String(half), '--owner', whale, '--queue', record.contracts.queue,
  );
  assert.equal(plan.code, 0, plan.stderr || plan.stdout);
  assert.equal(plan.json.blockers.length, 0);
  assert.ok(BigInt(plan.json.expected.assets) > 0n, 'previewAssetsOut must quote a payout');
  assert.ok(plan.json.expectedFormatted?.assets, 'withdraw plans must carry human twins (context decimals)');

  const pendingBefore = (await pc.readContract({ address: record.contracts.queue, abi: queueAbi, functionName: 'getRequestIds' })).length;
  await executeSteps(plan.json.steps, whale);
  const pendingAfter = (await pc.readContract({ address: record.contracts.queue, abi: queueAbi, functionName: 'getRequestIds' })).length;

  assert.equal(shares(whale), owned - half, 'shares must be escrowed by the queue');
  assert.equal(pendingAfter, pendingBefore + 1, 'queue must hold one new pending request');
  t.diagnostic(`queued ${half} shares; expected payout ${plan.json.expected.assets} (discount ${plan.json.context.discountBps} bps)`);
});
