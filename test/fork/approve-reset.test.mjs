import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, erc20Abi, erc4626Abi, parseUnits } from 'viem';
import { cli, ensureAnvil, snapshot, revert, executeSteps, pc, rpc, USDC } from './helpers.mjs';
import { approveNeedsReset } from '../../packages/vaults-plan/src/index.ts';

const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const STEAK_USDC = '0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB';
const STEAK_USDT = '0xbEef047a543E45807105E51A8BBEFCc5950fcfBa';
const OWNER = '0x00000000000000000000000000000000000a11ce';
const DEPOSIT = parseUnits('1000', 6);
const RESIDUAL = 1n;


const approveStep = (token, spender) => ({
  to: token,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, DEPOSIT] }),
});

const forkChain = await pc.getChainId().catch(() => null);
const skip = forkChain !== null && forkChain !== 1 ? `USDC/USDT live on chain 1, fork is chain ${forkChain}` : false;

let snapId;
before(async () => { await ensureAnvil(); });
beforeEach(async () => { if (!skip) snapId = await snapshot(); });
afterEach(async () => { if (!skip) await revert(snapId); });

async function withResidualAllowance(token, spender) {
  await rpc('anvil_dealERC20', [OWNER, token, `0x${DEPOSIT.toString(16)}`]);
  await executeSteps([{
    to: token, value: '0',
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, RESIDUAL] }),
  }], OWNER);
  const allowance = await pc.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [OWNER, spender] });
  assert.equal(allowance, RESIDUAL);
}

async function depositAndAssertMinted(t, steps, vault) {
  const cap = await pc.readContract({ address: vault, abi: erc4626Abi, functionName: 'maxDeposit', args: [OWNER] });
  if (cap < DEPOSIT) return t.skip(`vault maxDeposit ${cap} < ${DEPOSIT} at this fork block`);
  const before_ = await pc.readContract({ address: vault, abi: erc4626Abi, functionName: 'balanceOf', args: [OWNER] });
  for (const hash of await executeSteps(steps, OWNER)) {
    assert.equal((await pc.getTransactionReceipt({ hash })).status, 'success');
  }
  const after = await pc.readContract({ address: vault, abi: erc4626Abi, functionName: 'balanceOf', args: [OWNER] });
  assert.ok(after > before_, 'deposit must mint shares');
}

test('approveNeedsReset: USDC overwrites a residual allowance, USDT needs the reset', { skip }, async () => {
  await withResidualAllowance(USDC, STEAK_USDC);
  await withResidualAllowance(USDT, STEAK_USDT);
  assert.equal(await approveNeedsReset(pc, OWNER, approveStep(USDC, STEAK_USDC)), false);
  assert.equal(await approveNeedsReset(pc, OWNER, approveStep(USDT, STEAK_USDT)), true);
});

test('approveNeedsReset: USDT approve from zero returns no data and is not read as a failure', { skip }, async () => {
  assert.equal(await approveNeedsReset(pc, OWNER, approveStep(USDT, STEAK_USDT)), false);
});

test('USDC residual allowance ⇒ one approve step, plan executes', { skip }, async (t) => {
  await withResidualAllowance(USDC, STEAK_USDC);
  const plan = cli('morpho', 'plan-deposit', '--vault', STEAK_USDC, '--assets', String(DEPOSIT), '--owner', OWNER);
  assert.equal(plan.code, 0, plan.stderr || plan.stdout);
  assert.deepEqual(plan.json.steps.map((s) => s.kind), ['approve', 'deposit']);
  await depositAndAssertMinted(t, plan.json.steps, STEAK_USDC);
});

test('USDT residual allowance ⇒ reset + approve, plan executes', { skip }, async (t) => {
  await withResidualAllowance(USDT, STEAK_USDT);
  const plan = cli('morpho', 'plan-deposit', '--vault', STEAK_USDT, '--assets', String(DEPOSIT), '--owner', OWNER);
  assert.equal(plan.code, 0, plan.stderr || plan.stdout);
  assert.deepEqual(plan.json.steps.map((s) => s.kind), ['approveReset', 'approve', 'deposit']);
  await depositAndAssertMinted(t, plan.json.steps, STEAK_USDT);
});
