import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, getAddress, zeroAddress } from 'viem';
import { morphoVaultAbi, erc20Abi } from '../../packages/vaults-morpho/src/abi.ts';
import {
  getVaultMeta, getPosition, checkGates, previewDeposit, previewRedeem,
  approve, deposit, redeem, withdraw,
} from '../../packages/vaults-morpho/src/core.ts';
import {
  encodeApprove, encodeApproveReset, encodeDeposit, encodeRedeem, encodeWithdraw,
} from '../../packages/vaults-morpho/src/encode.ts';
import { planDeposit, planRedeem } from '../../packages/vaults-morpho/src/plan.ts';
import { fakePc, revertError, rpcInternalError, zeroDataError } from './fakes.mjs';

const VAULT = '0x' + 'cc'.repeat(20);
const ASSET = '0x' + 'aa'.repeat(20);
const OWNER = '0x' + 'bb'.repeat(20);
const RECEIVER = '0x' + 'dd'.repeat(20);
const GATE_RS = '0x' + '01'.repeat(20);
const GATE_SS = '0x' + '02'.repeat(20);
const GATE_RA = '0x' + '03'.repeat(20);
const GATE_SA = '0x' + '04'.repeat(20);

const noGetter = revertError('receiveSharesGate');

function v1Reads(over = {}) {
  return {
    [`${VAULT}.symbol`]: 'mUSDC',
    [`${VAULT}.decimals`]: 18,
    [`${VAULT}.asset`]: ASSET,
    [`${VAULT}.totalAssets`]: 1_000n,
    [`${VAULT}.balanceOf`]: 500n,
    [`${VAULT}.maxWithdraw`]: 400n,
    [`${VAULT}.convertToAssets`]: (args) => args[0] * 2n,
    [`${VAULT}.previewDeposit`]: (args) => args[0] * 3n,
    [`${VAULT}.previewRedeem`]: (args) => args[0] * 2n,
    [`${VAULT}.receiveSharesGate`]: noGetter,
    [`${VAULT}.sendSharesGate`]: noGetter,
    [`${VAULT}.receiveAssetsGate`]: noGetter,
    [`${VAULT}.sendAssetsGate`]: noGetter,
    [`${ASSET}.symbol`]: 'USDC',
    [`${ASSET}.decimals`]: 6,
    [`${ASSET}.balanceOf`]: 1_000n,
    [`${ASSET}.allowance`]: 0n,
    ...over,
  };
}

function v2Reads(over = {}) {
  return v1Reads({
    [`${VAULT}.maxWithdraw`]: 0n,
    [`${VAULT}.receiveSharesGate`]: zeroAddress,
    [`${VAULT}.sendSharesGate`]: zeroAddress,
    [`${VAULT}.receiveAssetsGate`]: zeroAddress,
    [`${VAULT}.sendAssetsGate`]: zeroAddress,
    ...over,
  });
}

function gatedReads(perms, over = {}) {
  return v2Reads({
    [`${VAULT}.receiveSharesGate`]: GATE_RS,
    [`${VAULT}.sendSharesGate`]: GATE_SS,
    [`${VAULT}.receiveAssetsGate`]: GATE_RA,
    [`${VAULT}.sendAssetsGate`]: GATE_SA,
    [`${GATE_RS}.canReceiveShares`]: perms.rs ?? true,
    [`${GATE_SS}.canSendShares`]: perms.ss ?? true,
    [`${GATE_RA}.canReceiveAssets`]: perms.ra ?? true,
    [`${GATE_SA}.canSendAssets`]: perms.sa ?? true,
    ...over,
  });
}

const codes = (plan) => plan.blockers.map((b) => b.code);

test('morpho getVaultMeta: V1 when receiveSharesGate reverts, V2 when it reads', async () => {
  const v1 = await getVaultMeta(fakePc(v1Reads()), VAULT);
  assert.deepEqual(v1, {
    vault: VAULT, shareSymbol: 'mUSDC', shareDecimals: 18, asset: ASSET,
    assetSymbol: 'USDC', assetDecimals: 6, totalAssets: 1_000n, isV2: false,
  });
  assert.equal((await getVaultMeta(fakePc(v2Reads()), VAULT)).isV2, true);
  const noData = await getVaultMeta(fakePc(v1Reads({ [`${VAULT}.receiveSharesGate`]: zeroDataError('receiveSharesGate') })), VAULT);
  assert.equal(noData.isV2, false);
});

test('morpho getVaultMeta: a transient RPC error on the V2 probe propagates instead of reading as V1', async () => {
  const pc = fakePc(v2Reads({ [`${VAULT}.receiveSharesGate`]: rpcInternalError('receiveSharesGate') }));
  await assert.rejects(getVaultMeta(pc, VAULT), { name: 'ContractFunctionExecutionError' });
  await assert.rejects(getVaultMeta(fakePc(v2Reads({ [`${VAULT}.receiveSharesGate`]: new Error('socket hang up') })), VAULT), /socket hang up/);
});

test('morpho getPosition converts shares and tolerates a reverting maxWithdraw', async () => {
  const pc = fakePc(v1Reads({ [`${ASSET}.allowance`]: 9n }));
  assert.deepEqual(await getPosition(pc, VAULT, ASSET, OWNER), {
    shares: 500n, assets: 1_000n, assetBalance: 1_000n, allowance: 9n, maxWithdrawRaw: 400n,
  });
  assert.deepEqual(pc.calls.find((c) => c.functionName === 'allowance').args, [OWNER, VAULT]);

  const empty = fakePc(v1Reads({ [`${VAULT}.balanceOf`]: 0n, [`${VAULT}.maxWithdraw`]: revertError('maxWithdraw') }));
  const pos = await getPosition(empty, VAULT, ASSET, OWNER);
  assert.equal(pos.assets, 0n);
  assert.equal(pos.maxWithdrawRaw, 0n);
  assert.equal(empty.calls.some((c) => c.functionName === 'convertToAssets'), false);
});

test('morpho checkGates: V1 is ungated and allows everything', async () => {
  assert.deepEqual(await checkGates(fakePc(v1Reads()), VAULT, OWNER), { gated: false, canDeposit: true, canWithdraw: true });
  const noData = fakePc(v1Reads({ [`${VAULT}.receiveSharesGate`]: zeroDataError('receiveSharesGate') }));
  assert.deepEqual(await checkGates(noData, VAULT, OWNER), { gated: false, canDeposit: true, canWithdraw: true });
});

test('morpho checkGates: a transient RPC error on a gated vault propagates instead of failing open', async () => {
  const pc = fakePc(gatedReads({}, { [`${VAULT}.sendAssetsGate`]: rpcInternalError('sendAssetsGate') }));
  await assert.rejects(checkGates(pc, VAULT, OWNER), { name: 'ContractFunctionExecutionError' });
  await assert.rejects(planDeposit(pc, VAULT, { assets: 100n, owner: OWNER }), { name: 'ContractFunctionExecutionError' });
});

test('morpho checkGates: V2 with all-zero gates is ungated without probing gate contracts', async () => {
  const pc = fakePc(v2Reads());
  assert.deepEqual(await checkGates(pc, VAULT, OWNER), { gated: false, canDeposit: true, canWithdraw: true });
  assert.equal(pc.calls.some((c) => c.functionName.startsWith('can')), false);
});

test('morpho getPosition and checkGates reject on an RPC failure instead of reading 0 or denied', async () => {
  await assert.rejects(getPosition(fakePc(v1Reads({ [`${VAULT}.maxWithdraw`]: new Error('socket hang up') })), VAULT, ASSET, OWNER), /socket hang up/);
  await assert.rejects(checkGates(fakePc(gatedReads({ ra: new Error('socket hang up') })), VAULT, OWNER), /socket hang up/);
});

test('morpho checkGates: each gate maps to the right side', async () => {
  assert.deepEqual(await checkGates(fakePc(gatedReads({})), VAULT, OWNER), { gated: true, canDeposit: true, canWithdraw: true });
  assert.deepEqual(await checkGates(fakePc(gatedReads({ rs: false })), VAULT, OWNER), { gated: true, canDeposit: false, canWithdraw: true });
  assert.deepEqual(await checkGates(fakePc(gatedReads({ sa: false })), VAULT, OWNER), { gated: true, canDeposit: false, canWithdraw: true });
  assert.deepEqual(await checkGates(fakePc(gatedReads({ ss: false })), VAULT, OWNER), { gated: true, canDeposit: true, canWithdraw: false });
  assert.deepEqual(await checkGates(fakePc(gatedReads({ ra: false })), VAULT, OWNER), { gated: true, canDeposit: true, canWithdraw: false });
  const pc = fakePc(gatedReads({ ra: revertError('canReceiveAssets') }));
  assert.deepEqual(await checkGates(pc, VAULT, OWNER), { gated: true, canDeposit: true, canWithdraw: false });
  assert.deepEqual(pc.calls.find((c) => c.functionName === 'canReceiveAssets').args, [OWNER]);
});

test('morpho checkGates: only one gate set means gated, the zero gates pass', async () => {
  const pc = fakePc(v2Reads({ [`${VAULT}.sendAssetsGate`]: GATE_SA, [`${GATE_SA}.canSendAssets`]: false }));
  assert.deepEqual(await checkGates(pc, VAULT, OWNER), { gated: true, canDeposit: false, canWithdraw: true });
});

test('morpho previews pass through the vault getters', async () => {
  const pc = fakePc(v1Reads());
  assert.equal(await previewDeposit(pc, VAULT, 10n), 30n);
  assert.equal(await previewRedeem(pc, VAULT, 10n), 20n);
});

test('morpho write helpers simulate, send the simulated call and wait for the receipt', async () => {
  const account = { address: OWNER, type: 'json-rpc' };
  const run = async (fn, result) => {
    const sim = [];
    const sent = [];
    const waited = [];
    const pc = {
      getChainId: async () => 1,
      simulateContract: async (p) => { sim.push(p); return { result }; },
      waitForTransactionReceipt: async ({ hash }) => { waited.push(hash); return { status: 'success', transactionHash: hash, logs: [] }; },
    };
    const wc = { account, chain: { id: 1 }, writeContract: async (r) => { sent.push(r); return '0xabc'; } };
    const out = await fn(pc, wc);
    assert.equal(sim[0].account, account);
    assert.deepEqual(sent, [{ ...sim[0], chain: wc.chain }]);
    assert.deepEqual(waited, ['0xabc']);
    return { out, p: sim[0] };
  };

  let r = await run((pc, wc) => approve(pc, wc, ASSET, VAULT, 5n));
  assert.deepEqual(r.out, { hash: '0xabc' });
  assert.equal(r.p.address, ASSET);
  assert.deepEqual(r.p.args, [VAULT, 5n]);

  r = await run((pc, wc) => deposit(pc, wc, VAULT, 5n, RECEIVER), 15n);
  assert.deepEqual(r.out, { hash: '0xabc', shares: 15n });
  assert.equal(r.p.functionName, 'deposit');
  assert.deepEqual(r.p.args, [5n, RECEIVER]);

  r = await run((pc, wc) => redeem(pc, wc, VAULT, 5n, RECEIVER, OWNER), 10n);
  assert.deepEqual(r.out, { hash: '0xabc', assets: 10n });
  assert.deepEqual(r.p.args, [5n, RECEIVER, OWNER]);

  r = await run((pc, wc) => withdraw(pc, wc, VAULT, 5n, RECEIVER, OWNER), 3n);
  assert.deepEqual(r.out, { hash: '0xabc', shares: 3n });
  assert.equal(r.p.functionName, 'withdraw');
  assert.deepEqual(r.p.args, [5n, RECEIVER, OWNER]);
});

test('morpho encoders produce decodable calldata against the right targets', () => {
  const ap = encodeApprove(ASSET, VAULT, 5n);
  assert.equal(ap.kind, 'approve');
  assert.equal(ap.to, ASSET);
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: ap.data }).args, [getAddress(VAULT), 5n]);

  const rs = encodeApproveReset(ASSET, VAULT);
  assert.equal(rs.kind, 'approveReset');
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: rs.data }).args, [getAddress(VAULT), 0n]);

  const dep = encodeDeposit(VAULT, 5n, RECEIVER);
  assert.equal(dep.to, VAULT);
  assert.deepEqual(decodeFunctionData({ abi: morphoVaultAbi, data: dep.data }), { functionName: 'deposit', args: [5n, getAddress(RECEIVER)] });

  const red = encodeRedeem(VAULT, 6n, RECEIVER, OWNER);
  assert.equal(red.kind, 'redeem');
  assert.deepEqual(decodeFunctionData({ abi: morphoVaultAbi, data: red.data }), { functionName: 'redeem', args: [6n, getAddress(RECEIVER), getAddress(OWNER)] });

  const wd = encodeWithdraw(VAULT, 7n, RECEIVER, OWNER);
  assert.equal(wd.kind, 'withdraw');
  assert.equal(wd.to, VAULT);
  assert.equal(wd.value, '0');
  assert.deepEqual(decodeFunctionData({ abi: morphoVaultAbi, data: wd.data }), { functionName: 'withdraw', args: [7n, getAddress(RECEIVER), getAddress(OWNER)] });
});

test('morpho planDeposit V1: approve + deposit to an explicit receiver, no V2 warning', async () => {
  const plan = await planDeposit(fakePc(v1Reads(), { chainId: 8453 }), VAULT, { assets: 100n, owner: OWNER, receiver: RECEIVER });
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.warnings, []);
  assert.equal(plan.family, 'morpho');
  assert.equal(plan.chainId, 8453);
  assert.deepEqual(plan.expected, { shares: '300' });
  assert.deepEqual(plan.context, {
    asset: ASSET, assetSymbol: 'USDC', assetDecimals: 6, shareSymbol: 'mUSDC', shareDecimals: 18, version: 'v1', gated: false,
  });
  assert.deepEqual(plan.steps.map((s) => s.kind), ['approve', 'deposit']);
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: plan.steps[0].data }).args, [getAddress(VAULT), 100n]);
  assert.deepEqual(decodeFunctionData({ abi: morphoVaultAbi, data: plan.steps[1].data }).args, [100n, getAddress(RECEIVER)]);
});

test('morpho planDeposit V2: sufficient allowance skips approve, receiver defaults to owner, max* warning', async () => {
  const plan = await planDeposit(fakePc(v2Reads({ [`${ASSET}.allowance`]: 100n })), VAULT, { assets: 100n, owner: OWNER });
  assert.equal(plan.context.version, 'v2');
  assert.deepEqual(plan.steps.map((s) => s.kind), ['deposit']);
  assert.deepEqual(decodeFunctionData({ abi: morphoVaultAbi, data: plan.steps[0].data }).args, [100n, getAddress(OWNER)]);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /max\* getters always return 0/);
});

test('morpho planDeposit blocks on gate denial and insufficient balance', async () => {
  const plan = await planDeposit(fakePc(gatedReads({ sa: false }, { [`${ASSET}.balanceOf`]: 1n })), VAULT, { assets: 100n, owner: OWNER });
  assert.deepEqual(codes(plan), ['GATE_DENIED', 'INSUFFICIENT_BALANCE']);
  assert.deepEqual(plan.steps, []);
  assert.deepEqual(plan.warnings, []);
  assert.equal(plan.context.gated, true);
});

test('morpho planRedeem happy path: expected assets from previewRedeem and a single redeem step', async () => {
  const plan = await planRedeem(fakePc(v1Reads(), { chainId: 8453 }), VAULT, { shares: 200n, owner: OWNER, receiver: RECEIVER });
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.action, 'redeem');
  assert.equal(plan.chainId, 8453);
  assert.deepEqual(plan.expected, { assets: '400' });
  assert.equal(plan.context.version, 'v1');
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /REVERTS when underlying market liquidity is insufficient/);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].to, VAULT);
  assert.deepEqual(decodeFunctionData({ abi: morphoVaultAbi, data: plan.steps[0].data }), {
    functionName: 'redeem', args: [200n, getAddress(RECEIVER), getAddress(OWNER)],
  });
});

test('morpho planRedeem V2 defaults receiver to owner', async () => {
  const plan = await planRedeem(fakePc(v2Reads()), VAULT, { shares: 500n, owner: OWNER });
  assert.equal(plan.context.version, 'v2');
  assert.deepEqual(decodeFunctionData({ abi: morphoVaultAbi, data: plan.steps[0].data }).args, [500n, getAddress(OWNER), getAddress(OWNER)]);
});

test('morpho planRedeem blocks on gate denial and insufficient shares without previewing', async () => {
  const pc = fakePc(gatedReads({ ss: false }));
  const plan = await planRedeem(pc, VAULT, { shares: 501n, owner: OWNER });
  assert.deepEqual(codes(plan), ['GATE_DENIED', 'INSUFFICIENT_SHARES']);
  assert.deepEqual(plan.steps, []);
  assert.deepEqual(plan.expected, {});
  assert.equal(pc.calls.some((c) => c.functionName === 'previewRedeem'), false);
});
