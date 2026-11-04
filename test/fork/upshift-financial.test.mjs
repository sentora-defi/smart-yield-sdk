/**
 * Write-path suite for the upshift_evm family against "Sentora USD"
 * (API-listed TokenizedVault) on a mainnet fork. Plans are built through the
 * CLI and executed raw from an impersonated USDC whale.
 *
 * The vault has sender whitelists and pause switches — the suite adapts:
 * when the whale is gated, it asserts the plan BLOCKS correctly (exit 7)
 * instead of executing, which still validates the preflight logic.
 */
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnits } from 'viem';
import { cli, ensureAnvil, snapshot, revert, findUsdcWhale, executeSteps, pc, rpc, USDC, erc20Abi } from './helpers.mjs';
import { getPendingWithdrawals } from '../../packages/vaults-upshift-financial/src/core.ts';

const VAULT = process.env.UPSHIFT_EVM_VAULT ?? '0x74aD2F789Ed583DBd141bbdafC673fE1F033718b'; // Sentora USD
const DEPOSIT = parseUnits('1000', 6);

// Sentora USD lives on Ethereum — skip the whole file on other forks (e.g. Ink)
const forkChain = await pc.getChainId().catch(() => null);
const skip = forkChain !== null && forkChain !== 1 ? `Sentora USD is on chain 1, fork is chain ${forkChain}` : false;

let whale;
let snapId;

before(async () => {
  await ensureAnvil();
  if (!skip) whale = await findUsdcWhale();
});
beforeEach(async () => { if (!skip) snapId = await snapshot(); });
afterEach(async () => { if (!skip) await revert(snapId); });

function shares(owner) {
  const r = cli('upshift_evm', 'position', '--vault', VAULT, '--owner', owner);
  assert.equal(r.code, 0, r.stderr);
  return BigInt(r.json.shares);
}

test('detect classifies the TokenizedVault as upshift_evm', { skip }, () => {
  const r = cli('detect', '--vault', VAULT);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.family, 'upshift_evm');
});

test('detect refuses the receipt token (not a vault) instead of guessing', { skip }, () => {
  const meta = cli('upshift_evm', 'meta', '--vault', VAULT);
  assert.equal(meta.code, 0, meta.stderr);
  const r = cli('detect', '--vault', meta.json.lpToken);
  assert.equal(r.code, 3);
  assert.equal(r.error.code, 'NOT_FOUND');
});

test('meta: vault and LP token are distinct contracts with coherent decimals', { skip }, () => {
  const r = cli('upshift_evm', 'meta', '--vault', VAULT);
  assert.equal(r.code, 0, r.stderr);
  assert.notEqual(r.json.lpToken.toLowerCase(), r.json.vault.toLowerCase());
  assert.match(r.json.asset, /^0x[0-9a-fA-F]{40}$/);
  assert.ok(Number(r.json.shareDecimals) > 0);
  assert.ok(BigInt(r.json.sharePrice) > 0n);
});

test('write path: deposit → queued redeem → claim-too-early (or gated ⇒ blocked, exit 7)', { skip }, async (t) => {
  const gates = cli('upshift_evm', 'gates', '--vault', VAULT, '--owner', whale);
  assert.equal(gates.code, 0, gates.stderr);

  const plan = cli('upshift_evm', 'plan-deposit', '--vault', VAULT, '--amount', String(DEPOSIT), '--owner', whale);

  if (!gates.json.canSend) {
    t.diagnostic('whale is not sender-whitelisted — asserting the blocked path');
    assert.equal(plan.code, 7, plan.stderr || plan.stdout);
    assert.ok(plan.json.blockers.some((b) => b.code === 'SENDER_NOT_WHITELISTED'));
    assert.equal(plan.json.steps.length, 0);
    return;
  }

  assert.equal(plan.code, 0, plan.stderr || plan.stdout);
  assert.equal(plan.json.blockers.length, 0);
  const before_ = shares(whale);
  await executeSteps(plan.json.steps, whale);
  const minted = shares(whale) - before_;
  assert.equal(minted, BigInt(plan.json.expected.shares));
  t.diagnostic(`deposit minted ${minted} LP shares`);

  const half = minted / 2n;
  const redeem = cli('upshift_evm', 'plan-redeem', '--vault', VAULT, '--shares', String(half), '--owner', whale);
  if (redeem.code === 7 && redeem.json.blockers.some((b) => b.code === 'NOT_TIMELOCKED')) {
    t.diagnostic('vault has no timelock — falling back to instant redemption');
    const instant = cli('upshift_evm', 'plan-redeem', '--vault', VAULT, '--shares', String(half), '--owner', whale, '--instant');
    assert.equal(instant.code, 0, instant.stderr || instant.stdout);
    await executeSteps(instant.json.steps, whale);
    assert.equal(shares(whale), before_ + minted - half);
    return;
  }

  assert.equal(redeem.code, 0, redeem.stderr || redeem.stdout);
  assert.ok(redeem.json.context.claimDate, 'queued plan must carry the on-chain claim date');
  assert.ok(redeem.json.expectedFormatted, 'redeem plans must carry human twins (context decimals)');
  await executeSteps(redeem.json.steps, whale);
  assert.equal(shares(whale), before_ + minted - half);
  t.diagnostic(`queued ${half} shares for ${JSON.stringify(redeem.json.context.claimDate)}`);

  const d = redeem.json.context.claimDate;
  const dateArgs = ['--year', String(d.year), '--month', String(d.month), '--day', String(d.day)];
  const early = cli('upshift_evm', 'plan-claim', '--vault', VAULT, '--owner', whale, ...dateArgs);
  assert.equal(early.code, 7, 'claim before the epoch must block');
  assert.ok(early.json.blockers.some((b) => b.code === 'TOO_EARLY' || b.code === 'NOTHING_TO_CLAIM'));

  // warp past the claim epoch and claim for real
  const nowTs = (await pc.getBlock()).timestamp;
  const target = BigInt(redeem.json.context.claimableEpoch);
  await rpc('evm_increaseTime', [Number(target - nowTs + 3600n)]);
  await rpc('evm_mine', []);

  const claim = cli('upshift_evm', 'plan-claim', '--vault', VAULT, '--owner', whale, ...dateArgs);
  assert.equal(claim.code, 0, claim.stderr || claim.stdout);
  assert.equal(claim.json.steps.length, 1);
  assert.equal(BigInt(claim.json.expected.shares), half, 'claimable shares must equal the queued amount');

  const usdcBefore = await pc.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [whale] });
  await executeSteps(claim.json.steps, whale);
  const received = (await pc.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [whale] })) - usdcBefore;
  assert.equal(received, BigInt(claim.json.expected.assetsAfterFee));
  t.diagnostic(`claimed ${received} USDC after warping to epoch ${target}`);
});

test('blocked plan: insufficient balance ⇒ exit 7, no steps', { skip }, () => {
  const plan = cli(
    'upshift_evm', 'plan-deposit', '--vault', VAULT,
    '--amount', String(10n ** 18n), // 1e12 USDC — nobody holds that
    '--owner', '0x000000000000000000000000000000000000dEaD',
  );
  assert.equal(plan.code, 7, plan.stderr || plan.stdout);
  assert.equal(plan.json.steps.length, 0);
  assert.ok(plan.json.blockers.length > 0);
});

test('--human amounts produce identical steps to base units (when plan is executable)', { skip }, () => {
  const base = cli('upshift_evm', 'plan-deposit', '--vault', VAULT, '--amount', '1000000000', '--owner', whale);
  const human = cli('upshift_evm', 'plan-deposit', '--vault', VAULT, '--amount', '1000', '--human', '--owner', whale);
  assert.equal(base.code, human.code);
  assert.deepEqual(human.json.steps, base.json.steps);
  assert.deepEqual(human.json.blockers, base.json.blockers);
});

test('pending withdrawals: a 60-day-old unpaid request stays listed next to a fresh one until claimed', { skip }, async (t) => {
  const gates = cli('upshift_evm', 'gates', '--vault', VAULT, '--owner', whale);
  assert.equal(gates.code, 0, gates.stderr);
  if (!gates.json.canSend) return t.skip('whale is not sender-whitelisted');

  const secondsOfDay = Number((await pc.getBlock()).timestamp % 86400n);
  if (secondsOfDay > 86400 - 600) {
    await rpc('evm_increaseTime', [86400 - secondsOfDay + 600]);
    await rpc('evm_mine', []);
  }

  const deposit = cli('upshift_evm', 'plan-deposit', '--vault', VAULT, '--amount', String(DEPOSIT), '--owner', whale);
  assert.equal(deposit.code, 0, deposit.stderr || deposit.stdout);
  const before_ = shares(whale);
  await executeSteps(deposit.json.steps, whale);
  const quarter = (shares(whale) - before_) / 4n;

  async function request() {
    const plan = cli('upshift_evm', 'plan-redeem', '--vault', VAULT, '--shares', String(quarter), '--owner', whale);
    assert.equal(plan.code, 0, plan.stderr || plan.stdout);
    const hashes = await executeSteps(plan.json.steps, whale);
    const receipt = await pc.getTransactionReceipt({ hash: hashes.at(-1) });
    const { timestamp } = await pc.getBlock({ blockNumber: receipt.blockNumber });
    return { requestedAt: timestamp, blockNumber: receipt.blockNumber, date: plan.json.context.claimDate };
  }

  const old = await request();
  await rpc('evm_increaseTime', [60 * 86400]);
  await rpc('evm_mine', []);
  const fresh = await request();

  const requests = [old, fresh].map(({ requestedAt, blockNumber }) => ({ requestedAt, blockNumber }));
  const pending = await getPendingWithdrawals(pc, VAULT, whale, requests);
  assert.deepEqual(pending.map((p) => [p.date, p.shares, p.status]), [
    [old.date, quarter, 'claimable'],
    [fresh.date, quarter, 'pending'],
  ]);

  const d = old.date;
  const claim = cli('upshift_evm', 'plan-claim', '--vault', VAULT, '--owner', whale,
    '--year', String(d.year), '--month', String(d.month), '--day', String(d.day));
  assert.equal(claim.code, 0, claim.stderr || claim.stdout);
  await executeSteps(claim.json.steps, whale);

  const after = await getPendingWithdrawals(pc, VAULT, whale, requests);
  assert.deepEqual(after.map((p) => p.date), [fresh.date]);
});
