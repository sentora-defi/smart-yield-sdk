import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionRevertedError, decodeFunctionData, getAddress, zeroAddress } from 'viem';
import { tokenizedVaultAbi, erc20Abi } from '../../packages/vaults-upshift-financial/src/abi.ts';
import {
  getVaultMeta, getPosition, checkGates, previewDeposit, previewRedemption, getWithdrawalEpoch, getClaimable,
  approve, approveShares, deposit, requestRedeem, instantRedeem, claim,
} from '../../packages/vaults-upshift-financial/src/core.ts';
import {
  encodeApprove, encodeApproveReset, encodeApproveShares, encodeDeposit, encodeRequestRedeem, encodeInstantRedeem, encodeClaim,
} from '../../packages/vaults-upshift-financial/src/encode.ts';
import { planDeposit, planRedeem, planClaim } from '../../packages/vaults-upshift-financial/src/plan.ts';
import { fakePc, revertError } from './fakes.mjs';

const VAULT = '0x' + '74'.repeat(20);
const LP = '0x' + '75'.repeat(20);
const ASSET = '0x' + 'aa'.repeat(20);
const ALT = '0x' + 'ab'.repeat(20);
const OWNER = '0x' + 'bb'.repeat(20);
const RECEIVER = '0x' + 'dd'.repeat(20);
const SENDERS_WL = '0x' + '5e'.repeat(20);
const ASSETS_WL = '0x' + 'a5'.repeat(20);
const DATE = { year: 2026, month: 11, day: 3 };

function reads(over = {}) {
  return {
    [`${VAULT}.asset`]: ASSET,
    [`${VAULT}.lpTokenAddress`]: LP,
    [`${VAULT}.getTotalAssets`]: 1_000n,
    [`${VAULT}.getSharePrice`]: 1_050_000n,
    [`${VAULT}.depositsPaused`]: false,
    [`${VAULT}.withdrawalsPaused`]: false,
    [`${VAULT}.depositCap`]: 10_000n,
    [`${VAULT}.maxDepositAmount`]: 5_000n,
    [`${VAULT}.maxWithdrawalAmount`]: 5_000n,
    [`${VAULT}.instantRedemptionFee`]: 50n,
    [`${VAULT}.withdrawalFee`]: 10n,
    [`${VAULT}.lagDuration`]: 86_400n,
    [`${VAULT}.sendersWhitelistAddress`]: zeroAddress,
    [`${VAULT}.assetsWhitelistAddress`]: ASSETS_WL,
    [`${VAULT}.previewDeposit`]: (args) => [args[1] * 2n, args[1]],
    [`${VAULT}.previewRedemption`]: (args) => [args[0] * 3n, args[1] ? args[0] * 3n - 2n : args[0] * 3n - 1n],
    [`${VAULT}.getWithdrawalEpoch`]: [2026n, 11n, 3n, 1_800n],
    [`${VAULT}.getBurnableAmountByReceiver`]: 40n,
    [`${VAULT}.getScheduledTransactionsByDate`]: [2n, 1_500n],
    [`${LP}.symbol`]: 'upUSDC',
    [`${LP}.decimals`]: 18,
    [`${LP}.totalSupply`]: 900n,
    [`${LP}.balanceOf`]: 100n,
    [`${LP}.allowance`]: 0n,
    [`${ASSET}.symbol`]: 'USDC',
    [`${ASSET}.decimals`]: 6,
    [`${ASSET}.balanceOf`]: 1_000n,
    [`${ASSET}.allowance`]: 0n,
    [`${ALT}.balanceOf`]: 1_000n,
    [`${ALT}.allowance`]: 0n,
    [`${ASSETS_WL}.isWhitelisted`]: false,
    ...over,
  };
}

const codes = (plan) => plan.blockers.map((b) => b.code);

test('upshift getVaultMeta reads the vault, LP token and reference asset', async () => {
  assert.deepEqual(await getVaultMeta(fakePc(reads()), VAULT), {
    vault: VAULT, lpToken: LP, shareSymbol: 'upUSDC', shareDecimals: 18, asset: ASSET, assetSymbol: 'USDC', assetDecimals: 6,
    totalAssets: 1_000n, totalSupply: 900n, sharePrice: 1_050_000n, depositsPaused: false, withdrawalsPaused: false,
    depositCap: 10_000n, maxDepositAmount: 5_000n, maxWithdrawalAmount: 5_000n,
    instantRedemptionFee: 50n, withdrawalFee: 10n, lagDuration: 86_400n,
  });
});

test('upshift getPosition: shares on the LP token, queued (non-instant) preview for value', async () => {
  const pc = fakePc(reads({ [`${LP}.allowance`]: 7n, [`${ASSET}.allowance`]: 3n }));
  assert.deepEqual(await getPosition(pc, VAULT, ASSET, OWNER), {
    shares: 100n, assets: 300n, assetBalance: 1_000n, allowance: 3n, shareAllowance: 7n,
  });
  assert.deepEqual(pc.calls.find((c) => c.functionName === 'previewRedemption').args, [100n, false]);
  for (const c of pc.calls.filter((x) => x.functionName === 'allowance')) assert.deepEqual(c.args, [OWNER, VAULT]);

  const empty = fakePc(reads({ [`${LP}.balanceOf`]: 0n }));
  assert.equal((await getPosition(empty, VAULT, ASSET, OWNER)).assets, 0n);
  assert.equal(empty.calls.some((c) => c.functionName === 'previewRedemption'), false);
});

test('upshift checkGates: ungated sender, reference asset always allowed without a whitelist read', async () => {
  const pc = fakePc(reads());
  assert.deepEqual(await checkGates(pc, VAULT, OWNER), { sendersGated: false, canSend: true, assetAllowed: true });
  assert.deepEqual(await checkGates(pc, VAULT, OWNER, ASSET.toUpperCase().replace('0X', '0x')), { sendersGated: false, canSend: true, assetAllowed: true });
  assert.equal(pc.calls.some((c) => c.functionName === 'isWhitelisted'), false);
});

test('upshift checkGates: gated sender and non-reference asset consult the whitelists', async () => {
  const pc = fakePc(reads({
    [`${VAULT}.sendersWhitelistAddress`]: SENDERS_WL,
    [`${SENDERS_WL}.isWhitelisted`]: (args) => args[0] === OWNER,
    [`${ASSETS_WL}.isWhitelisted`]: (args) => args[0] === ALT,
  }));
  assert.deepEqual(await checkGates(pc, VAULT, OWNER, ALT), { sendersGated: true, canSend: true, assetAllowed: true });
  assert.deepEqual(await checkGates(pc, VAULT, RECEIVER, '0x' + 'ef'.repeat(20)), { sendersGated: true, canSend: false, assetAllowed: false });
});

test('upshift checkGates: reverting whitelist reads fail closed', async () => {
  const pc = fakePc(reads({
    [`${VAULT}.sendersWhitelistAddress`]: SENDERS_WL,
    [`${SENDERS_WL}.isWhitelisted`]: revertError('isWhitelisted'),
    [`${ASSETS_WL}.isWhitelisted`]: revertError('isWhitelisted'),
  }));
  assert.deepEqual(await checkGates(pc, VAULT, OWNER, ALT), { sendersGated: true, canSend: false, assetAllowed: false });
});

test('upshift checkGates and planDeposit reject on an RPC failure instead of blocking', async () => {
  const senders = fakePc(reads({ [`${VAULT}.sendersWhitelistAddress`]: SENDERS_WL, [`${SENDERS_WL}.isWhitelisted`]: new Error('socket hang up') }));
  await assert.rejects(checkGates(senders, VAULT, OWNER), /socket hang up/);
  await assert.rejects(checkGates(fakePc(reads({ [`${ASSETS_WL}.isWhitelisted`]: new Error('socket hang up') })), VAULT, OWNER, ALT), /socket hang up/);
  await assert.rejects(planDeposit(fakePc(reads({ [`${VAULT}.previewDeposit`]: new Error('socket hang up') })), VAULT, { amount: 100n, owner: OWNER }), /socket hang up/);
});

test('upshift previews, epoch and claimable reads map the tuples', async () => {
  const pc = fakePc(reads());
  assert.deepEqual(await previewDeposit(pc, VAULT, ALT, 10n), { shares: 20n, amountInReferenceTokens: 10n });
  assert.deepEqual(await previewRedemption(pc, VAULT, 10n, true), { assetsAmount: 30n, assetsAfterFee: 28n });
  assert.deepEqual(await getWithdrawalEpoch(pc, VAULT), { year: 2026, month: 11, day: 3, claimableEpoch: 1_800n });
  assert.deepEqual(await getClaimable(pc, VAULT, DATE, RECEIVER), { shares: 40n, executionEpoch: 1_500n });
  assert.deepEqual(pc.calls.find((c) => c.functionName === 'getBurnableAmountByReceiver').args, [2026n, 11n, 3n, RECEIVER]);
  assert.deepEqual(pc.calls.find((c) => c.functionName === 'getScheduledTransactionsByDate').args, [2026n, 11n, 3n]);
});

test('upshift write helpers simulate, send and decode return values', async () => {
  const account = { address: OWNER, type: 'json-rpc' };
  const run = async (fn, result) => {
    const sim = [];
    const waited = [];
    const pc = {
      getChainId: async () => 1,
      simulateContract: async (p) => { sim.push(p); return { result }; },
      waitForTransactionReceipt: async ({ hash }) => { waited.push(hash); return { status: 'success', transactionHash: hash, logs: [] }; },
    };
    const wc = { account, chain: { id: 1 }, writeContract: async () => '0x01' };
    const out = await fn(pc, wc);
    assert.equal(sim[0].account, account);
    assert.deepEqual(waited, ['0x01']);
    return { out, p: sim[0] };
  };

  let r = await run((pc, wc) => approve(pc, wc, ASSET, VAULT, 5n));
  assert.deepEqual(r.out, { hash: '0x01' });
  assert.equal(r.p.address, ASSET);
  assert.deepEqual(r.p.args, [VAULT, 5n]);

  r = await run((pc, wc) => approveShares(pc, wc, LP, VAULT, 6n));
  assert.equal(r.p.address, LP);
  assert.deepEqual(r.p.args, [VAULT, 6n]);

  r = await run((pc, wc) => deposit(pc, wc, VAULT, ALT, 5n, RECEIVER), 9n);
  assert.deepEqual(r.out, { hash: '0x01', expectedShares: 9n });
  assert.deepEqual(r.p.args, [ALT, 5n, RECEIVER]);

  r = await run((pc, wc) => requestRedeem(pc, wc, VAULT, 5n, RECEIVER), [1_800n, 2026n, 11n, 3n]);
  assert.deepEqual(r.out, { hash: '0x01', claimableEpoch: 1_800n, claimDate: DATE });
  assert.deepEqual(r.p.args, [5n, RECEIVER]);

  r = await run((pc, wc) => instantRedeem(pc, wc, VAULT, 5n, RECEIVER));
  assert.deepEqual(r.out, { hash: '0x01' });
  assert.equal(r.p.functionName, 'instantRedeem');

  r = await run((pc, wc) => claim(pc, wc, VAULT, DATE, RECEIVER), [30n, 29n]);
  assert.deepEqual(r.out, { hash: '0x01', assetsAmount: 30n, assetsAfterFee: 29n });
  assert.deepEqual(r.p.args, [2026n, 11n, 3n, RECEIVER]);
});

test('upshift encoders decode to the expected function and args', () => {
  const dec = (abi, step) => decodeFunctionData({ abi, data: step.data });

  const ap = encodeApprove(ASSET, VAULT, 5n);
  assert.equal(ap.to, ASSET);
  assert.deepEqual(dec(erc20Abi, ap), { functionName: 'approve', args: [getAddress(VAULT), 5n] });

  const rs = encodeApproveReset(ASSET, VAULT);
  assert.equal(rs.kind, 'approveReset');
  assert.deepEqual(dec(erc20Abi, rs).args, [getAddress(VAULT), 0n]);

  const sh = encodeApproveShares(LP, VAULT, 6n);
  assert.equal(sh.kind, 'approveShares');
  assert.equal(sh.to, LP);
  assert.deepEqual(dec(erc20Abi, sh).args, [getAddress(VAULT), 6n]);

  assert.deepEqual(dec(tokenizedVaultAbi, encodeDeposit(VAULT, ALT, 5n, RECEIVER)), { functionName: 'deposit', args: [getAddress(ALT), 5n, getAddress(RECEIVER)] });
  assert.deepEqual(dec(tokenizedVaultAbi, encodeRequestRedeem(VAULT, 5n, RECEIVER)), { functionName: 'requestRedeem', args: [5n, getAddress(RECEIVER)] });

  const ir = encodeInstantRedeem(VAULT, 5n, RECEIVER);
  assert.equal(ir.kind, 'instantRedeem');
  assert.equal(ir.to, VAULT);
  assert.equal(ir.value, '0');
  assert.deepEqual(dec(tokenizedVaultAbi, ir), { functionName: 'instantRedeem', args: [5n, getAddress(RECEIVER)] });

  const cl = encodeClaim(VAULT, DATE, RECEIVER);
  assert.equal(cl.description, `Claim the queued redemption of 2026-11-3 to ${RECEIVER}`);
  assert.deepEqual(dec(tokenizedVaultAbi, cl), { functionName: 'claim', args: [2026n, 11n, 3n, getAddress(RECEIVER)] });
});

test('upshift planDeposit happy path with the reference asset: approve + deposit', async () => {
  const plan = await planDeposit(fakePc(reads(), { chainId: 98866 }), VAULT, { amount: 100n, owner: OWNER, receiver: RECEIVER });
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.family, 'upshift_evm');
  assert.equal(plan.chainId, 98866);
  assert.deepEqual(plan.expected, { shares: '200', amountInReferenceTokens: '100' });
  assert.deepEqual(plan.context, {
    assetIn: ASSET, lpToken: LP, referenceAsset: ASSET, assetSymbol: 'USDC', assetDecimals: 6,
    shareSymbol: 'upUSDC', shareDecimals: 18, sharePrice: '1050000',
  });
  assert.deepEqual(plan.steps.map((s) => s.kind), ['approve', 'deposit']);
  assert.equal(plan.steps[0].to, ASSET);
  assert.deepEqual(decodeFunctionData({ abi: tokenizedVaultAbi, data: plan.steps[1].data }).args, [getAddress(ASSET), 100n, getAddress(RECEIVER)]);
});

test('upshift planDeposit with a whitelisted alt asset resets a residual allowance the token will not overwrite', async () => {
  const pc = fakePc(reads({ [`${ASSETS_WL}.isWhitelisted`]: true, [`${ALT}.allowance`]: 1n }), { call: async () => { throw new ExecutionRevertedError(); } });
  const plan = await planDeposit(pc, VAULT, { amount: 100n, owner: OWNER, assetIn: ALT });
  assert.deepEqual(plan.steps.map((s) => [s.kind, s.to]), [['approveReset', ALT], ['approve', ALT], ['deposit', VAULT]]);
  assert.deepEqual(decodeFunctionData({ abi: tokenizedVaultAbi, data: plan.steps[2].data }).args, [getAddress(ALT), 100n, getAddress(OWNER)]);
});

test('upshift planDeposit: sufficient allowance emits only the deposit', async () => {
  const plan = await planDeposit(fakePc(reads({ [`${ASSET}.allowance`]: 100n })), VAULT, { amount: 100n, owner: OWNER });
  assert.deepEqual(plan.steps.map((s) => s.kind), ['deposit']);
});

test('upshift planDeposit blockers: paused, sender, max deposit, cap, balance', async () => {
  const pc = fakePc(reads({
    [`${VAULT}.depositsPaused`]: true,
    [`${VAULT}.sendersWhitelistAddress`]: SENDERS_WL,
    [`${SENDERS_WL}.isWhitelisted`]: false,
    [`${VAULT}.maxDepositAmount`]: 50n,
    [`${VAULT}.depositCap`]: 1_050n,
    [`${ASSET}.balanceOf`]: 10n,
  }));
  const plan = await planDeposit(pc, VAULT, { amount: 100n, owner: OWNER });
  assert.deepEqual(codes(plan), ['PAUSED', 'SENDER_NOT_WHITELISTED', 'MAX_DEPOSIT', 'DEPOSIT_CAP', 'INSUFFICIENT_BALANCE']);
  assert.deepEqual(plan.steps, []);
  assert.deepEqual(plan.expected, { shares: '200', amountInReferenceTokens: '100' });
});

test('upshift planDeposit: deposit exactly at the cap and per-tx max is allowed', async () => {
  const pc = fakePc(reads({ [`${VAULT}.maxDepositAmount`]: 100n, [`${VAULT}.depositCap`]: 1_100n }));
  assert.deepEqual((await planDeposit(pc, VAULT, { amount: 100n, owner: OWNER })).blockers, []);
});

test('upshift planDeposit: zero-share preview blocks AMOUNT_TOO_LOW', async () => {
  const plan = await planDeposit(fakePc(reads({ [`${VAULT}.previewDeposit`]: [0n, 1n] })), VAULT, { amount: 1n, owner: OWNER });
  assert.deepEqual(codes(plan), ['AMOUNT_TOO_LOW']);
});

test('upshift planDeposit: non-whitelisted asset or a reverting preview blocks ASSET_NOT_ALLOWED with no expected values', async () => {
  const notListed = await planDeposit(fakePc(reads()), VAULT, { amount: 100n, owner: OWNER, assetIn: ALT });
  assert.deepEqual(codes(notListed), ['ASSET_NOT_ALLOWED']);
  assert.deepEqual(notListed.expected, {});

  const reverted = await planDeposit(fakePc(reads({ [`${VAULT}.previewDeposit`]: revertError('previewDeposit') })), VAULT, { amount: 100n, owner: OWNER });
  assert.deepEqual(codes(reverted), ['ASSET_NOT_ALLOWED']);
  assert.deepEqual(reverted.expected, {});
});

test('upshift planRedeem queued: share approval, requestRedeem, claim date in context and warning', async () => {
  const plan = await planRedeem(fakePc(reads()), VAULT, { shares: 100n, owner: OWNER, receiver: RECEIVER });
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.action, 'requestRedeem');
  assert.deepEqual(plan.expected, { assets: '300', assetsAfterFee: '299' });
  assert.equal(plan.context.fee, '10');
  assert.deepEqual(plan.context.claimDate, DATE);
  assert.equal(plan.context.claimableEpoch, '1800');
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /claim\(2026, 11, 3, receiver\) after unix 1800/);
  assert.deepEqual(plan.steps.map((s) => [s.kind, s.to]), [['approveShares', LP], ['requestRedeem', VAULT]]);
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: plan.steps[0].data }).args, [getAddress(VAULT), 100n]);
  assert.deepEqual(decodeFunctionData({ abi: tokenizedVaultAbi, data: plan.steps[1].data }).args, [100n, getAddress(RECEIVER)]);
});

test('upshift planRedeem queued with existing share allowance skips approveShares', async () => {
  const plan = await planRedeem(fakePc(reads({ [`${LP}.allowance`]: 100n })), VAULT, { shares: 100n, owner: OWNER });
  assert.deepEqual(plan.steps.map((s) => s.kind), ['requestRedeem']);
  assert.deepEqual(decodeFunctionData({ abi: tokenizedVaultAbi, data: plan.steps[0].data }).args, [100n, getAddress(OWNER)]);
});

test('upshift planRedeem instant: no approval, no epoch read, instant fee in context, works without a timelock', async () => {
  const pc = fakePc(reads({ [`${VAULT}.lagDuration`]: 0n }));
  const plan = await planRedeem(pc, VAULT, { shares: 100n, owner: OWNER, instant: true });
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.action, 'instantRedeem');
  assert.deepEqual(plan.expected, { assets: '300', assetsAfterFee: '298' });
  assert.equal(plan.context.fee, '50');
  assert.equal(plan.context.claimDate, undefined);
  assert.deepEqual(plan.warnings, []);
  assert.deepEqual(plan.steps.map((s) => s.kind), ['instantRedeem']);
  assert.deepEqual(decodeFunctionData({ abi: tokenizedVaultAbi, data: plan.steps[0].data }).args, [100n, getAddress(OWNER)]);
  assert.equal(pc.calls.some((c) => c.functionName === 'getWithdrawalEpoch'), false);
});

test('upshift planRedeem blockers: paused, sender, shares, withdrawal limit, zero net, no timelock', async () => {
  const pc = fakePc(reads({
    [`${VAULT}.withdrawalsPaused`]: true,
    [`${VAULT}.sendersWhitelistAddress`]: SENDERS_WL,
    [`${SENDERS_WL}.isWhitelisted`]: false,
    [`${VAULT}.maxWithdrawalAmount`]: 1n,
    [`${VAULT}.previewRedemption`]: [600n, 0n],
    [`${VAULT}.lagDuration`]: 0n,
  }));
  const plan = await planRedeem(pc, VAULT, { shares: 200n, owner: OWNER });
  assert.deepEqual(codes(plan), ['PAUSED', 'SENDER_NOT_WHITELISTED', 'INSUFFICIENT_SHARES', 'WITHDRAWAL_LIMIT', 'AMOUNT_TOO_LOW', 'NOT_TIMELOCKED']);
  assert.deepEqual(plan.steps, []);
});

test('upshift planClaim happy path: claim step and queued preview of the claimable shares', async () => {
  const pc = fakePc(reads(), { blockTimestamp: 1_500n });
  const plan = await planClaim(pc, VAULT, { date: DATE, owner: OWNER, receiver: RECEIVER });
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.action, 'claim');
  assert.deepEqual(plan.expected, { shares: '40', assets: '120', assetsAfterFee: '119' });
  assert.deepEqual(plan.context, {
    claimDate: DATE, receiver: RECEIVER, shareSymbol: 'upUSDC', shareDecimals: 18, assetSymbol: 'USDC', assetDecimals: 6,
  });
  assert.equal(plan.steps.length, 1);
  assert.deepEqual(decodeFunctionData({ abi: tokenizedVaultAbi, data: plan.steps[0].data }), {
    functionName: 'claim', args: [2026n, 11n, 3n, getAddress(RECEIVER)],
  });
  assert.deepEqual(pc.calls.find((c) => c.functionName === 'getBurnableAmountByReceiver').args[3], RECEIVER);
  assert.deepEqual(pc.calls.filter((c) => c.functionName === 'previewRedemption').at(-1).args, [40n, false]);
});

test('upshift planClaim: receiver defaults to owner', async () => {
  const pc = fakePc(reads());
  const plan = await planClaim(pc, VAULT, { date: DATE, owner: OWNER });
  assert.equal(plan.context.receiver, OWNER);
  assert.equal(decodeFunctionData({ abi: tokenizedVaultAbi, data: plan.steps[0].data }).args[3], getAddress(OWNER));
});

test('upshift planClaim: too early against chain time', async () => {
  const plan = await planClaim(fakePc(reads(), { blockTimestamp: 1_499n }), VAULT, { date: DATE, owner: OWNER });
  assert.deepEqual(codes(plan), ['TOO_EARLY']);
  assert.match(plan.blockers[0].message, /after unix 1500, chain time is 1499/);
  assert.deepEqual(plan.steps, []);
});

test('upshift planClaim: nothing to claim takes precedence over timing, plus paused and sender blockers', async () => {
  const pc = fakePc(reads({
    [`${VAULT}.withdrawalsPaused`]: true,
    [`${VAULT}.sendersWhitelistAddress`]: SENDERS_WL,
    [`${SENDERS_WL}.isWhitelisted`]: false,
    [`${VAULT}.getBurnableAmountByReceiver`]: 0n,
  }), { blockTimestamp: 0n });
  const plan = await planClaim(pc, VAULT, { date: DATE, owner: OWNER });
  assert.deepEqual(codes(plan), ['PAUSED', 'SENDER_NOT_WHITELISTED', 'NOTHING_TO_CLAIM']);
  assert.deepEqual(plan.expected, {});
});
