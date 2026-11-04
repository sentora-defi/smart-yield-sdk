import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionRevertedError, decodeFunctionData, encodeAbiParameters, encodeEventTopics, getAddress, zeroAddress, zeroHash } from 'viem';
import {
  boringVaultAbi, tellerAbi, tellerDepositV2Abi, boringQueueAbi, erc20Abi,
  TELLER_DEPOSIT_SELECTOR, TELLER_DEPOSIT_SELECTOR_V2, QUEUE_REQUEST_WITHDRAW_SELECTOR,
} from '../../packages/vaults-boring/src/abi.ts';
import {
  preflight, getPosition, previewDepositShares, getWithdrawAssetConfig, previewWithdrawAssets,
  approveAsset, deposit, approveSharesToQueue, requestWithdraw, cancelWithdraw, isRequestPending,
} from '../../packages/vaults-boring/src/core.ts';
import { discoverConfig } from '../../packages/vaults-boring/src/discover.ts';
import {
  encodeApproveAsset, encodeApproveAssetReset, encodeDeposit, encodeApproveSharesToQueue, encodeRequestWithdraw,
} from '../../packages/vaults-boring/src/encode.ts';
import { planDeposit, planRequestWithdraw, readAssetAllowance } from '../../packages/vaults-boring/src/plan.ts';
import { fakePc, revertError, rpcInternalError, zeroDataError } from './fakes.mjs';

const VAULT = '0x' + '11'.repeat(20);
const AUTH = '0x' + '22'.repeat(20);
const TELLER = '0x' + '33'.repeat(20);
const ACC = '0x' + '44'.repeat(20);
const QUEUE = '0x' + '55'.repeat(20);
const ASSET = '0x' + 'aa'.repeat(20);
const OWNER = '0x' + 'bb'.repeat(20);
const OTHER = '0x' + '66'.repeat(20);
const OLD_QUEUE = '0x' + '77'.repeat(20);

const CFG = { vault: VAULT, teller: TELLER, accountant: ACC, queue: QUEUE, rolesAuthority: AUTH, chainId: 1 };
const FAR_FUTURE = 10n ** 12n;
const ONE = 10n ** 18n;

function baseReads(over = {}) {
  return {
    [`${AUTH}.canCall`]: (args) => args[2] === TELLER_DEPOSIT_SELECTOR || args[2] === QUEUE_REQUEST_WITHDRAW_SELECTOR,
    [`${TELLER}.isPaused`]: false,
    [`${TELLER}.assetData`]: [true, true, 100],
    [`${TELLER}.shareUnlockTime`]: 0n,
    [`${TELLER}.shareLockPeriod`]: 0n,
    [`${VAULT}.decimals`]: 18,
    [`${VAULT}.balanceOf`]: 5n * ONE,
    [`${VAULT}.allowance`]: 0n,
    [`${ACC}.getRateInQuoteSafe`]: 1_000_000n,
    [`${ASSET}.balanceOf`]: 10_000_000n,
    [`${ASSET}.allowance`]: 0n,
    [`${ASSET}.decimals`]: 6,
    [`${QUEUE}.withdrawAssets`]: [true, 86_400, 3_600, 1, 30, 10n],
    [`${QUEUE}.isPaused`]: false,
    [`${QUEUE}.previewAssetsOut`]: 999_000n,
    ...over,
  };
}

const codes = (plan) => plan.blockers.map((b) => b.code);

test('boring preflight: v1-only role, share lock in the future, asset allowed', async () => {
  const pc = fakePc(baseReads({ [`${TELLER}.shareUnlockTime`]: FAR_FUTURE }));
  const pf = await preflight(pc, CFG, ASSET, OWNER);
  assert.deepEqual(pf, {
    canDeposit: true, tellerDepositVariant: 'v1', tellerPaused: false, assetAllowed: true,
    sharePremiumBps: 100, shareUnlockTime: FAR_FUTURE, sharesLocked: true,
  });
  const selectors = pc.calls.filter((c) => c.functionName === 'canCall').map((c) => c.args[2]);
  assert.deepEqual(selectors.sort(), [TELLER_DEPOSIT_SELECTOR, TELLER_DEPOSIT_SELECTOR_V2].sort());
});

test('boring preflight: v2 role wins, shareUnlockTime revert reads as never locked', async () => {
  const pc = fakePc(baseReads({
    [`${AUTH}.canCall`]: (args) => args[2] === TELLER_DEPOSIT_SELECTOR_V2,
    [`${TELLER}.shareUnlockTime`]: revertError('shareUnlockTime'),
    [`${TELLER}.isPaused`]: true,
    [`${TELLER}.assetData`]: [false, false, 0],
  }));
  const pf = await preflight(pc, CFG, ASSET, OWNER);
  assert.equal(pf.canDeposit, true);
  assert.equal(pf.tellerDepositVariant, 'v2');
  assert.equal(pf.tellerPaused, true);
  assert.equal(pf.assetAllowed, false);
  assert.equal(pf.shareUnlockTime, 0n);
  assert.equal(pf.sharesLocked, false);
});

test('boring share-lock reads: a transient RPC error propagates instead of reading as unlocked', async () => {
  const unlock = fakePc(baseReads({ [`${TELLER}.shareUnlockTime`]: rpcInternalError('shareUnlockTime') }));
  await assert.rejects(preflight(unlock, CFG, ASSET, OWNER), { name: 'ContractFunctionExecutionError' });
  await assert.rejects(planRequestWithdraw(unlock, CFG, { assetOut: ASSET, shares: 1n, owner: OWNER }), { name: 'ContractFunctionExecutionError' });
  const period = fakePc(baseReads({ [`${TELLER}.shareLockPeriod`]: new Error('socket hang up') }));
  await assert.rejects(planDeposit(period, CFG, { asset: ASSET, amount: 1_000_000n, owner: OWNER }), /socket hang up/);
});

test('boring preflight: no role on either selector', async () => {
  const pf = await preflight(fakePc(baseReads({ [`${AUTH}.canCall`]: false })), CFG, ASSET, OWNER);
  assert.equal(pf.canDeposit, false);
  assert.equal(pf.tellerDepositVariant, 'v1');
});

test('boring getPosition values shares through the accountant rate', async () => {
  const pc = fakePc(baseReads({ [`${VAULT}.allowance`]: 7n, [`${ASSET}.allowance`]: 3n }));
  const pos = await getPosition(pc, CFG, ASSET, OWNER);
  assert.deepEqual(pos, {
    shares: 5n * ONE, assets: 5_000_000n, assetBalance: 10_000_000n, vaultAllowance: 3n, queueShareAllowance: 7n,
  });
  const vaultAllowanceCall = pc.calls.find((c) => c.address === VAULT && c.functionName === 'allowance');
  assert.deepEqual(vaultAllowanceCall.args, [OWNER, QUEUE]);
  const assetAllowanceCall = pc.calls.find((c) => c.address === ASSET && c.functionName === 'allowance');
  assert.deepEqual(assetAllowanceCall.args, [OWNER, VAULT]);
});

test('boring previewDepositShares applies the share premium haircut', async () => {
  const shares = await previewDepositShares(fakePc(baseReads()), CFG, ASSET, 1_000_000n);
  assert.equal(shares, (ONE * 9_900n) / 10_000n);
  const noPremium = await previewDepositShares(fakePc(baseReads({ [`${TELLER}.assetData`]: [true, true, 0] })), CFG, ASSET, 2_000_000n);
  assert.equal(noPremium, 2n * ONE);
});

test('boring getWithdrawAssetConfig maps the tuple to numbers', async () => {
  const w = await getWithdrawAssetConfig(fakePc(baseReads()), CFG, ASSET);
  assert.deepEqual(w, {
    allowWithdraws: true, secondsToMaturity: 86_400, minimumSecondsToDeadline: 3_600,
    minDiscountBps: 1, maxDiscountBps: 30, minimumShares: 10n,
  });
});

test('boring previewWithdrawAssets forwards shares and discount', async () => {
  const pc = fakePc(baseReads());
  assert.equal(await previewWithdrawAssets(pc, CFG, ASSET, 123n, 7), 999_000n);
  assert.deepEqual(pc.calls[0].args, [ASSET, 123n, 7]);
});

test('boring isRequestPending checks the live id set', async () => {
  const id = '0x' + 'ab'.repeat(32);
  const pc = fakePc({ [`${QUEUE}.getRequestIds`]: [id] });
  assert.equal(await isRequestPending(pc, CFG, id), true);
  assert.equal(await isRequestPending(pc, CFG, '0x' + 'cd'.repeat(32)), false);
});

function writeHarness({ result, logs = [] } = {}) {
  const simulated = [];
  const sent = [];
  const waited = [];
  const account = { address: OWNER, type: 'json-rpc' };
  const pc = {
    getChainId: async () => 1,
    simulateContract: async (params) => { simulated.push(params); return { result }; },
    waitForTransactionReceipt: async ({ hash }) => { waited.push(hash); return { status: 'success', transactionHash: hash, logs }; },
  };
  const wc = { account, chain: { id: 1 }, writeContract: async (req) => { sent.push(req); return '0xfeed'; } };
  return { pc, wc, simulated, sent, waited, account };
}

test('boring write helpers simulate with the wallet account, send the simulated request and wait', async () => {
  let h = writeHarness();
  assert.deepEqual(await approveAsset(h.pc, h.wc, CFG, ASSET, 9n), { hash: '0xfeed' });
  assert.equal(h.simulated[0].address, ASSET);
  assert.equal(h.simulated[0].functionName, 'approve');
  assert.deepEqual(h.simulated[0].args, [VAULT, 9n]);
  assert.equal(h.simulated[0].account, h.account);
  assert.deepEqual(h.sent[0], { ...h.simulated[0], chain: h.wc.chain });
  assert.deepEqual(h.waited, ['0xfeed']);

  h = writeHarness({ result: 42n });
  assert.deepEqual(await deposit(h.pc, h.wc, CFG, ASSET, 5n, 4n), { hash: '0xfeed', shares: 42n });
  assert.equal(h.simulated[0].address, TELLER);
  assert.deepEqual(h.simulated[0].args, [ASSET, 5n, 4n]);

  h = writeHarness();
  assert.deepEqual(await approveSharesToQueue(h.pc, h.wc, CFG, 8n), { hash: '0xfeed' });
  assert.equal(h.simulated[0].address, VAULT);
  assert.deepEqual(h.simulated[0].args, [QUEUE, 8n]);

  h = writeHarness();
  const req = {
    nonce: 1n, user: OWNER, assetOut: ASSET, amountOfShares: 2n, amountOfAssets: 3n,
    creationTime: 4, secondsToMaturity: 5, secondsToDeadline: 6,
  };
  assert.deepEqual(await cancelWithdraw(h.pc, h.wc, CFG, { ...req, extra: 'dropped' }), { hash: '0xfeed' });
  assert.equal(h.simulated[0].address, QUEUE);
  assert.equal(h.simulated[0].functionName, 'cancelOnChainWithdraw');
  assert.deepEqual(h.simulated[0].args, [req]);
});

test('boring requestWithdraw decodes the OnChainWithdrawRequested struct from the receipt', async () => {
  const requestId = '0x' + '99'.repeat(32);
  const event = boringQueueAbi.find((e) => e.type === 'event' && e.name === 'OnChainWithdrawRequested');
  const topics = encodeEventTopics({ abi: [event], eventName: 'OnChainWithdrawRequested', args: { requestId, user: OWNER, assetOut: ASSET } });
  const data = encodeAbiParameters(
    event.inputs.filter((i) => !i.indexed),
    [7n, 100n, 99n, 1_700_000_000, 86_400, 259_200],
  );
  const h = writeHarness({ result: requestId, logs: [{ address: QUEUE, topics, data, blockNumber: 1n, logIndex: 0, transactionIndex: 0, transactionHash: '0x' + '01'.repeat(32), blockHash: '0x' + '02'.repeat(32), removed: false }] });
  const out = await requestWithdraw(h.pc, h.wc, CFG, ASSET, 100n, 5, 259_200);
  assert.equal(out.hash, '0xfeed');
  assert.equal(out.requestId, requestId);
  assert.deepEqual(h.simulated[0].args, [ASSET, 100n, 5, 259_200]);
  assert.deepEqual(out.request, {
    nonce: 7n, user: getAddress(OWNER), assetOut: getAddress(ASSET), amountOfShares: 100n, amountOfAssets: 99n,
    creationTime: 1_700_000_000, secondsToMaturity: 86_400, secondsToDeadline: 259_200,
  });
});

test('boring encoders target the right contract with decodable calldata', () => {
  const approve = encodeApproveAsset(CFG, ASSET, 5n);
  assert.equal(approve.kind, 'approve');
  assert.equal(approve.to, ASSET);
  assert.equal(approve.value, '0');
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: approve.data }).args, [getAddress(VAULT), 5n]);

  const reset = encodeApproveAssetReset(CFG, ASSET);
  assert.equal(reset.kind, 'approveReset');
  assert.equal(reset.to, ASSET);
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: reset.data }).args, [getAddress(VAULT), 0n]);

  const v1 = encodeDeposit(CFG, ASSET, 5n, 4n);
  assert.equal(v1.to, TELLER);
  const d1 = decodeFunctionData({ abi: tellerAbi, data: v1.data });
  assert.equal(d1.functionName, 'deposit');
  assert.deepEqual(d1.args, [getAddress(ASSET), 5n, 4n]);
  assert.equal(v1.data.slice(0, 10), TELLER_DEPOSIT_SELECTOR);

  const v2 = encodeDeposit(CFG, ASSET, 5n, 4n, 'v2');
  assert.equal(v2.data.slice(0, 10), TELLER_DEPOSIT_SELECTOR_V2);
  assert.deepEqual(decodeFunctionData({ abi: tellerDepositV2Abi, data: v2.data }).args, [getAddress(ASSET), 5n, 4n, zeroAddress]);
  const v2ref = encodeDeposit(CFG, ASSET, 5n, 4n, 'v2', OTHER);
  assert.equal(decodeFunctionData({ abi: tellerDepositV2Abi, data: v2ref.data }).args[3], getAddress(OTHER));

  const shares = encodeApproveSharesToQueue(CFG, 6n);
  assert.equal(shares.kind, 'approveShares');
  assert.equal(shares.to, VAULT);
  assert.deepEqual(decodeFunctionData({ abi: boringVaultAbi, data: shares.data }).args, [getAddress(QUEUE), 6n]);

  const req = encodeRequestWithdraw(CFG, ASSET, 6n, 3, 900);
  assert.equal(req.kind, 'requestWithdraw');
  assert.equal(req.to, QUEUE);
  const dr = decodeFunctionData({ abi: boringQueueAbi, data: req.data });
  assert.equal(dr.functionName, 'requestOnChainWithdraw');
  assert.deepEqual(dr.args, [getAddress(ASSET), 6n, 3, 900]);
});

test('boring planDeposit happy path: approve then v1 deposit with slippage-adjusted minimumMint', async () => {
  const plan = await planDeposit(fakePc(baseReads()), CFG, { asset: ASSET, amount: 1_000_000n, owner: OWNER });
  const shares = (ONE * 9_900n) / 10_000n;
  const minimumMint = (shares * 9_950n) / 10_000n;
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.warnings, []);
  assert.equal(plan.family, 'boring');
  assert.equal(plan.action, 'deposit');
  assert.equal(plan.chainId, 1);
  assert.deepEqual(plan.expected, { shares: shares.toString(), minimumMint: minimumMint.toString() });
  assert.equal(plan.context.tellerDepositVariant, 'v1');
  assert.equal(plan.context.assetDecimals, 6);
  assert.equal(plan.context.shareDecimals, 18);
  assert.equal(plan.context.sharePremiumBps, 100);
  assert.equal(plan.context.shareLockPeriodSeconds, '0');
  assert.deepEqual(plan.steps.map((s) => s.kind), ['approve', 'deposit']);
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: plan.steps[0].data }).args, [getAddress(VAULT), 1_000_000n]);
  assert.equal(plan.steps[1].to, TELLER);
  assert.deepEqual(decodeFunctionData({ abi: tellerAbi, data: plan.steps[1].data }).args, [getAddress(ASSET), 1_000_000n, minimumMint]);
});

test('boring planDeposit: a residual allowance the token will not overwrite is reset first, v2 teller, share lock warning, custom slippage', async () => {
  const pc = fakePc(baseReads({
    [`${AUTH}.canCall`]: true,
    [`${ASSET}.allowance`]: 1n,
    [`${TELLER}.shareLockPeriod`]: 3_600n,
    [`${TELLER}.assetData`]: [true, true, 0],
  }), { call: async () => { throw new ExecutionRevertedError(); } });
  const plan = await planDeposit(pc, CFG, { asset: ASSET, amount: 1_000_000n, owner: OWNER, slippageBps: 0 });
  assert.deepEqual(plan.steps.map((s) => s.kind), ['approveReset', 'approve', 'deposit']);
  assert.equal(plan.expected.minimumMint, ONE.toString());
  assert.equal(plan.context.tellerDepositVariant, 'v2');
  assert.equal(plan.context.shareLockPeriodSeconds, '3600');
  assert.equal(plan.steps[2].data.slice(0, 10), TELLER_DEPOSIT_SELECTOR_V2);
  assert.deepEqual(decodeFunctionData({ abi: tellerDepositV2Abi, data: plan.steps[2].data }).args, [getAddress(ASSET), 1_000_000n, ONE, zeroAddress]);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /re-locks the ENTIRE share balance .* 3600s/);
});

test('boring planDeposit: sufficient allowance skips approve; shareLockPeriod revert reads as 0', async () => {
  const pc = fakePc(baseReads({ [`${ASSET}.allowance`]: 1_000_000n, [`${TELLER}.shareLockPeriod`]: zeroDataError('shareLockPeriod') }));
  const plan = await planDeposit(pc, CFG, { asset: ASSET, amount: 1_000_000n, owner: OWNER });
  assert.deepEqual(plan.steps.map((s) => s.kind), ['deposit']);
  assert.equal(plan.context.shareLockPeriodSeconds, '0');
  assert.deepEqual(plan.warnings, []);
});

test('boring planDeposit collects every blocker and emits no steps', async () => {
  const pc = fakePc(baseReads({
    [`${TELLER}.isPaused`]: true,
    [`${TELLER}.assetData`]: [false, false, 0],
    [`${AUTH}.canCall`]: false,
    [`${ASSET}.balanceOf`]: 1n,
  }));
  const plan = await planDeposit(pc, CFG, { asset: ASSET, amount: 1_000_000n, owner: OWNER });
  assert.deepEqual(codes(plan), ['PAUSED', 'ASSET_NOT_ALLOWED', 'ROLE_DENIED', 'INSUFFICIENT_BALANCE']);
  assert.deepEqual(plan.steps, []);
  assert.equal(plan.context.tellerDepositVariant, undefined);
});

test('boring planDeposit rejects out-of-range slippage before any read', async () => {
  const pc = fakePc({});
  for (const slippageBps of [-1, 10_000, 1.5]) {
    await assert.rejects(planDeposit(pc, CFG, { asset: ASSET, amount: 1n, owner: OWNER, slippageBps }), /slippageBps must be an integer/);
  }
  assert.equal(pc.calls.length, 0);
});

test('boring planRequestWithdraw happy path: default discount/deadline, approve shares then request', async () => {
  const plan = await planRequestWithdraw(fakePc(baseReads()), CFG, { assetOut: ASSET, shares: ONE, owner: OWNER });
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.action, 'requestWithdraw');
  assert.deepEqual(plan.expected, { assets: '999000' });
  assert.equal(plan.context.discountBps, 1);
  assert.equal(plan.context.secondsToDeadline, 3 * 24 * 3600);
  assert.equal(plan.context.secondsToMaturity, 86_400);
  assert.equal(plan.context.assetDecimals, 6);
  assert.equal(plan.context.shareDecimals, 18);
  assert.equal(plan.warnings.length, 1);
  assert.deepEqual(plan.steps.map((s) => s.kind), ['approveShares', 'requestWithdraw']);
  assert.equal(plan.steps[0].to, VAULT);
  assert.deepEqual(decodeFunctionData({ abi: boringVaultAbi, data: plan.steps[0].data }).args, [getAddress(QUEUE), ONE]);
  assert.equal(plan.steps[1].to, QUEUE);
  assert.deepEqual(decodeFunctionData({ abi: boringQueueAbi, data: plan.steps[1].data }).args, [getAddress(ASSET), ONE, 1, 259_200]);
});

test('boring planRequestWithdraw: explicit params, queue minimum deadline above 3 days, existing share allowance', async () => {
  const pc = fakePc(baseReads({
    [`${QUEUE}.withdrawAssets`]: [true, 0, 400_000, 1, 30, 10n],
    [`${VAULT}.allowance`]: ONE,
  }));
  const dflt = await planRequestWithdraw(pc, CFG, { assetOut: ASSET, shares: ONE, owner: OWNER });
  assert.equal(dflt.context.secondsToDeadline, 400_000);
  assert.deepEqual(dflt.steps.map((s) => s.kind), ['requestWithdraw']);

  const explicit = await planRequestWithdraw(pc, CFG, { assetOut: ASSET, shares: ONE, owner: OWNER, discountBps: 30, secondsToDeadline: 0 });
  assert.equal(explicit.context.discountBps, 30);
  assert.equal(explicit.context.secondsToDeadline, 0);
  assert.deepEqual(decodeFunctionData({ abi: boringQueueAbi, data: explicit.steps[0].data }).args, [getAddress(ASSET), ONE, 30, 0]);
});

test('boring planRequestWithdraw collects every blocker', async () => {
  const pc = fakePc(baseReads({
    [`${QUEUE}.isPaused`]: true,
    [`${QUEUE}.withdrawAssets`]: [false, 0, 0, 5, 10, 100n],
    [`${VAULT}.balanceOf`]: 1n,
    [`${TELLER}.shareUnlockTime`]: FAR_FUTURE,
  }));
  const plan = await planRequestWithdraw(pc, CFG, { assetOut: ASSET, shares: 50n, owner: OWNER, discountBps: 11 });
  assert.deepEqual(codes(plan), ['PAUSED', 'ASSET_NOT_ALLOWED', 'BELOW_MINIMUM', 'DISCOUNT_OUT_OF_RANGE', 'INSUFFICIENT_SHARES', 'SHARES_LOCKED']);
  assert.deepEqual(plan.steps, []);
  assert.deepEqual(plan.expected, {});
  assert.equal(pc.calls.some((c) => c.functionName === 'previewAssetsOut'), false);
});

test('boring planRequestWithdraw: discount below the minimum is out of range; shareUnlockTime revert is unlocked', async () => {
  const pc = fakePc(baseReads({
    [`${QUEUE}.withdrawAssets`]: [true, 0, 0, 5, 10, 0n],
    [`${TELLER}.shareUnlockTime`]: zeroDataError('shareUnlockTime'),
  }));
  const plan = await planRequestWithdraw(pc, CFG, { assetOut: ASSET, shares: 1n, owner: OWNER, discountBps: 4 });
  assert.deepEqual(codes(plan), ['DISCOUNT_OUT_OF_RANGE']);
});

test('boring planRequestWithdraw: an unreadable queue pause state fails the plan', async () => {
  const pc = fakePc(baseReads({ [`${QUEUE}.isPaused`]: new Error('rpc down') }));
  await assert.rejects(planRequestWithdraw(pc, CFG, { assetOut: ASSET, shares: 1n, owner: OWNER }), /rpc down/);
});

test('boring planRequestWithdraw blocks QUEUE_UNKNOWN without reading chain state', async () => {
  const pc = fakePc({});
  for (const queue of [zeroAddress, undefined]) {
    const plan = await planRequestWithdraw(pc, { ...CFG, queue }, { assetOut: ASSET, shares: 1n, owner: OWNER });
    assert.deepEqual(codes(plan), ['QUEUE_UNKNOWN']);
    assert.deepEqual(plan.steps, []);
  }
  assert.equal(pc.calls.length, 0);
});

test('boring planRequestWithdraw validates uint24 deadline and uint16 discount', async () => {
  const pc = fakePc({});
  const p = { assetOut: ASSET, shares: 1n, owner: OWNER };
  await assert.rejects(planRequestWithdraw(pc, CFG, { ...p, secondsToDeadline: 16_777_216 }), /uint24/);
  await assert.rejects(planRequestWithdraw(pc, CFG, { ...p, secondsToDeadline: -1 }), /uint24/);
  await assert.rejects(planRequestWithdraw(pc, CFG, { ...p, secondsToDeadline: 1.5 }), /uint24/);
  await assert.rejects(planRequestWithdraw(pc, CFG, { ...p, discountBps: 65_536 }), /uint16/);
  await assert.rejects(planRequestWithdraw(pc, CFG, { ...p, discountBps: -1 }), /uint16/);
  await assert.rejects(planRequestWithdraw(pc, CFG, { ...p, discountBps: 0.5 }), /uint16/);
});

test('boring readAssetAllowance reads owner → vault', async () => {
  const pc = fakePc({ [`${ASSET}.allowance`]: 77n });
  assert.equal(await readAssetAllowance(pc, CFG, ASSET, OWNER), 77n);
  assert.deepEqual(pc.calls[0].args, [OWNER, VAULT]);
});

function discoverReads(over = {}) {
  return {
    [`${VAULT}.authority`]: AUTH,
    [`${VAULT}.hook`]: TELLER,
    [`${TELLER}.vault`]: VAULT,
    [`${TELLER}.accountant`]: ACC,
    [`${QUEUE}.boringVault`]: VAULT,
    [`${OLD_QUEUE}.boringVault`]: VAULT,
    [`${OTHER}.boringVault`]: OTHER,
    [`${QUEUE}.authority`]: AUTH,
    [`${OLD_QUEUE}.authority`]: AUTH,
    [`${AUTH}.isCapabilityPublic`]: true,
    [`${AUTH}.getRolesWithCapability`]: zeroHash,
    ...over,
  };
}

function logsPc(reads, logsByEvent) {
  const getLogsCalls = [];
  const pc = fakePc(reads, {
    getLogs: async (params) => {
      getLogsCalls.push(params);
      const v = logsByEvent[params.event.name];
      if (v instanceof Error) throw v;
      return v ?? [];
    },
  });
  pc.getLogsCalls = getLogsCalls;
  return pc;
}

test('boring discoverConfig scans authority events and picks the newest linked queue', async () => {
  const pc = logsPc(discoverReads(), {
    RoleCapabilityUpdated: [{ args: { target: OLD_QUEUE } }, { args: { target: TELLER } }, { args: {} }],
    PublicCapabilityUpdated: [{ args: { target: VAULT } }, { args: { target: OTHER } }, { args: { target: QUEUE } }],
  });
  const d = await discoverConfig(pc, VAULT, { fromBlock: 123n });
  assert.deepEqual(d.config, { vault: VAULT, teller: TELLER, accountant: ACC, queue: QUEUE, rolesAuthority: AUTH, chainId: 1 });
  assert.equal(d.queueUnknown, false);
  assert.deepEqual(d.warnings, []);
  assert.deepEqual(pc.getLogsCalls.map((c) => [c.address, c.fromBlock, c.toBlock]), [[AUTH, 123n, 'latest'], [AUTH, 123n, 'latest']]);
  assert.equal(pc.calls.some((c) => c.address === VAULT && c.functionName === 'boringVault'), false);
});

test('boring discoverConfig: a reverting probe target is skipped, failed scan is flagged, no queue found', async () => {
  const pc = logsPc(discoverReads({ [`${TELLER}.boringVault`]: revertError('boringVault') }), {
    RoleCapabilityUpdated: new Error('range too large'),
    PublicCapabilityUpdated: [{ args: { target: TELLER } }, { args: { target: VAULT } }, { args: { target: OTHER } }],
  });
  const d = await discoverConfig(pc, VAULT);
  assert.equal(d.config.queue, zeroAddress);
  assert.equal(d.queueUnknown, true);
  assert.equal(d.warnings.length, 2);
  assert.match(d.warnings[0], /scan failed or was truncated/);
  assert.match(d.warnings[1], /No BoringOnChainQueue found/);
  assert.equal(pc.getLogsCalls[0].fromBlock, 0n);
});

test('boring discoverConfig: partial scan still returns a queue found in the surviving event set', async () => {
  const pc = logsPc(discoverReads(), {
    RoleCapabilityUpdated: [{ args: { target: QUEUE } }],
    PublicCapabilityUpdated: new Error('capped'),
  });
  const d = await discoverConfig(pc, VAULT);
  assert.equal(d.config.queue, QUEUE);
  assert.equal(d.queueUnknown, false);
  assert.equal(d.warnings.length, 1);
  assert.match(d.warnings[0], /truncated/);
});

test('boring discoverConfig: explicit teller skips hook(); explicit queue skips the scan', async () => {
  const pc = logsPc(discoverReads({ [`${VAULT}.hook`]: new Error('should not be read') }), {});
  const d = await discoverConfig(pc, VAULT, { teller: TELLER, queue: QUEUE });
  assert.equal(d.config.teller, TELLER);
  assert.equal(d.config.queue, QUEUE);
  assert.equal(pc.getLogsCalls.length, 0);
});

test('boring discoverConfig: explicit queue whose boringVault() reverts is rejected', async () => {
  const pc = logsPc(discoverReads({ [`${QUEUE}.boringVault`]: revertError('boringVault') }), {});
  await assert.rejects(discoverConfig(pc, VAULT, { queue: QUEUE }), new RegExp(`reports boringVault\\(\\) = ${zeroAddress}`));
});

test('boring discoverConfig: zero hook and a mismatched teller both throw', async () => {
  await assert.rejects(discoverConfig(logsPc(discoverReads({ [`${VAULT}.hook`]: zeroAddress }), {}), VAULT), /no before-transfer hook/);
  await assert.rejects(discoverConfig(logsPc(discoverReads({ [`${TELLER}.vault`]: OTHER }), {}), VAULT), /points at vault/);
});
