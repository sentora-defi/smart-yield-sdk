import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'viem';
import { finalizeResult } from '../../packages/vaults-cli/src/result.ts';
import { toJson } from '../../packages/vaults-cli/src/output.ts';
import { zeroDataError } from './fakes.mjs';

import { planDeposit as boringPlanDeposit, planRequestWithdraw as boringPlanRequestWithdraw } from '../../packages/vaults-boring/src/plan.ts';
import { planDeposit as morphoPlanDeposit, planRedeem as morphoPlanRedeem } from '../../packages/vaults-morpho/src/plan.ts';
import { planDeposit as upshiftPlanDeposit, planRedeem as upshiftPlanRedeem } from '../../packages/vaults-upshift-financial/src/plan.ts';

const addr = (b) => '0x' + b.repeat(20);
const OWNER = addr('0b');
const VAULT = addr('a1');
const ASSET = addr('a2');
const OTHER_ASSET = addr('a3');

// unknown reads fail like a missing getter (zero data), which is what drives the families' revert fallbacks (e.g. morpho V1 detection)
function mockPc(reads) {
  return {
    getChainId: async () => 1,
    readContract: async ({ address, functionName, args }) => {
      const r = reads[address.toLowerCase()]?.[functionName];
      if (r === undefined) throw zeroDataError(functionName);
      return typeof r === 'function' ? r(args) : r;
    },
  };
}

const byCode = (plan, code) => {
  const b = plan.blockers.find((x) => x.code === code);
  assert.ok(b, `expected a ${code} blocker, got ${JSON.stringify(plan.blockers)}`);
  return b;
};

const TELLER = addr('b1');
const ACCOUNTANT = addr('b2');
const QUEUE = addr('b3');
const ROLES = addr('b4');
const boringCfg = { vault: VAULT, teller: TELLER, accountant: ACCOUNTANT, queue: QUEUE, rolesAuthority: ROLES, chainId: 1 };

function boringPc({ assetBalance = 0n, shares = 0n, minimumShares = 0n } = {}) {
  return mockPc({
    [VAULT]: { decimals: 18, balanceOf: shares, allowance: 0n },
    [ASSET]: { decimals: 6, balanceOf: assetBalance, allowance: 0n },
    [TELLER]: { isPaused: false, assetData: [true, true, 0], shareLockPeriod: 0n, shareUnlockTime: 0n },
    [ACCOUNTANT]: { getRateInQuoteSafe: 1_000_000n },
    [ROLES]: { canCall: true, getRolesWithCapability: '0x' + '00'.repeat(32) },
    [QUEUE]: { isPaused: false, withdrawAssets: [true, 0, 0, 0, 100, minimumShares] },
  });
}

test('boring planDeposit: INSUFFICIENT_BALANCE carries asset amounts and decimals', async () => {
  const plan = await boringPlanDeposit(boringPc({ assetBalance: 998_000_000n }), boringCfg, { asset: ASSET, amount: 5_000_000_000n, owner: OWNER });
  assert.deepEqual(byCode(plan, 'INSUFFICIENT_BALANCE'), {
    code: 'INSUFFICIENT_BALANCE',
    message: 'Owner holds 998000000 asset units, needs 5000000000',
    available: '998000000', required: '5000000000', decimals: 6,
  });
  const { payload, blocked } = finalizeResult(plan);
  assert.equal(blocked, true);
  assert.deepEqual(JSON.parse(toJson(payload, false)).blockers, [{
    code: 'INSUFFICIENT_BALANCE',
    message: 'Owner holds 998000000 asset units, needs 5000000000',
    available: '998000000', required: '5000000000', decimals: 6,
  }]);
});

test('boring planRequestWithdraw: INSUFFICIENT_SHARES and BELOW_MINIMUM carry share amounts', async () => {
  const pc = boringPc({ shares: 10n, minimumShares: 1_000n });
  const plan = await boringPlanRequestWithdraw(pc, boringCfg, { assetOut: ASSET, shares: 500n, owner: OWNER });
  assert.deepEqual(byCode(plan, 'INSUFFICIENT_SHARES'), {
    code: 'INSUFFICIENT_SHARES',
    message: 'Owner holds 10 shares, needs 500',
    available: '10', required: '500', decimals: 18,
  });
  assert.deepEqual(byCode(plan, 'BELOW_MINIMUM'), {
    code: 'BELOW_MINIMUM',
    message: 'Queue minimum is 1000 shares, requested 500',
    available: '500', required: '1000', decimals: 18,
  });
});

function morphoPc({ assetBalance = 0n, shares = 0n } = {}) {
  return mockPc({
    [VAULT]: { symbol: 'mUSDC', decimals: 18, asset: ASSET, totalAssets: 0n, balanceOf: shares, previewDeposit: 1n, convertToAssets: 0n },
    [ASSET]: { symbol: 'USDC', decimals: 6, balanceOf: assetBalance, allowance: 0n },
  });
}

test('morpho planDeposit: INSUFFICIENT_BALANCE carries asset amounts and decimals', async () => {
  const plan = await morphoPlanDeposit(morphoPc({ assetBalance: 7n }), VAULT, { assets: 9n, owner: OWNER });
  assert.deepEqual(byCode(plan, 'INSUFFICIENT_BALANCE'), {
    code: 'INSUFFICIENT_BALANCE',
    message: 'Owner holds 7 USDC units, needs 9',
    available: '7', required: '9', decimals: 6,
  });
});

test('morpho planRedeem: INSUFFICIENT_SHARES carries share amounts and decimals', async () => {
  const plan = await morphoPlanRedeem(morphoPc({ shares: 3n }), VAULT, { shares: 4n, owner: OWNER });
  assert.deepEqual(byCode(plan, 'INSUFFICIENT_SHARES'), {
    code: 'INSUFFICIENT_SHARES',
    message: 'Owner holds 3 shares, needs 4',
    available: '3', required: '4', decimals: 18,
  });
});

const LP = addr('c1');
const ZERO = addr('00');
const ASSETS_WHITELIST = addr('c2');

function upshiftPc({
  referenceAsset = ASSET, assetBalance = 0n, shares = 0n, totalAssets = 0n, depositCap = 10n ** 30n,
  maxDepositAmount = 10n ** 30n, maxWithdrawalAmount = 10n ** 30n, amountInReference, previewShares = 1n, assetsAmount = 1n,
} = {}) {
  const token = (decimals, balance) => ({ symbol: 'T', decimals, totalSupply: 0n, balanceOf: balance, allowance: 0n });
  return mockPc({
    [VAULT]: {
      asset: referenceAsset, lpTokenAddress: LP, getTotalAssets: totalAssets, getSharePrice: 1n,
      depositsPaused: false, withdrawalsPaused: false, depositCap, maxDepositAmount, maxWithdrawalAmount,
      instantRedemptionFee: 0n, withdrawalFee: 0n, lagDuration: 1n,
      sendersWhitelistAddress: ZERO, assetsWhitelistAddress: ASSETS_WHITELIST,
      previewDeposit: ([, amountIn]) => [previewShares, amountInReference ?? amountIn],
      previewRedemption: () => [assetsAmount, assetsAmount],
    },
    [ASSETS_WHITELIST]: { isWhitelisted: true },
    [LP]: token(18, shares),
    [ASSET]: token(6, assetBalance),
    [OTHER_ASSET]: token(8, assetBalance),
  });
}

test('upshift planDeposit: INSUFFICIENT_BALANCE, MAX_DEPOSIT and DEPOSIT_CAP carry amounts', async () => {
  const pc = upshiftPc({ assetBalance: 998_000_000n, totalAssets: 900n, depositCap: 1_000n, maxDepositAmount: 400n });
  const plan = await upshiftPlanDeposit(pc, VAULT, { amount: 5_000_000_000n, owner: OWNER });
  assert.deepEqual(byCode(plan, 'INSUFFICIENT_BALANCE'), {
    code: 'INSUFFICIENT_BALANCE',
    message: 'Owner holds 998000000 asset units, needs 5000000000',
    available: '998000000', required: '5000000000', decimals: 6,
  });
  assert.deepEqual(byCode(plan, 'MAX_DEPOSIT'), {
    code: 'MAX_DEPOSIT',
    message: 'Deposit is 5000000000 reference units, per-tx max is 400',
    available: '400', required: '5000000000', decimals: 6,
  });
  assert.deepEqual(byCode(plan, 'DEPOSIT_CAP'), {
    code: 'DEPOSIT_CAP',
    message: 'Cap 1000 reached: vault holds 900, deposit adds 5000000000',
    available: '100', required: '5000000000', decimals: 6,
  });
});

test('upshift planDeposit: DEPOSIT_CAP room floors at zero when the vault is already over cap', async () => {
  const plan = await upshiftPlanDeposit(upshiftPc({ assetBalance: 10n, totalAssets: 1_500n, depositCap: 1_000n }), VAULT, { amount: 10n, owner: OWNER });
  const b = byCode(plan, 'DEPOSIT_CAP');
  assert.equal(b.available, '0');
  assert.equal(b.required, '10');
});

test('upshift planDeposit: with a non-reference assetIn, cap blockers are in reference units', async () => {
  const pc = upshiftPc({ assetBalance: 10n ** 12n, amountInReference: 3_000n, totalAssets: 900n, depositCap: 1_000n, maxDepositAmount: 400n });
  const plan = await upshiftPlanDeposit(pc, VAULT, { amount: 10n ** 11n, owner: OWNER, assetIn: OTHER_ASSET });
  assert.deepEqual(plan.blockers.map((b) => [b.code, b.available, b.required, b.decimals]), [
    ['MAX_DEPOSIT', '400', '3000', 6],
    ['DEPOSIT_CAP', '100', '3000', 6],
  ]);
});

test('upshift planDeposit: INSUFFICIENT_BALANCE with a non-reference assetIn omits decimals', async () => {
  const plan = await upshiftPlanDeposit(upshiftPc({ assetBalance: 1n }), VAULT, { amount: 2n, owner: OWNER, assetIn: OTHER_ASSET });
  assert.deepEqual(byCode(plan, 'INSUFFICIENT_BALANCE'), {
    code: 'INSUFFICIENT_BALANCE',
    message: 'Owner holds 1 asset units, needs 2',
    available: '1', required: '2',
  });
});

test('upshift planDeposit: a lowercase assetIn matching the checksummed reference asset still gets decimals', async () => {
  const pc = upshiftPc({ referenceAsset: getAddress(ASSET), assetBalance: 1n });
  const plan = await upshiftPlanDeposit(pc, VAULT, { amount: 2n, owner: OWNER, assetIn: ASSET });
  assert.equal(byCode(plan, 'INSUFFICIENT_BALANCE').decimals, 6);
});

test('upshift AMOUNT_TOO_LOW carries the zero preview against a one-unit minimum', async () => {
  const dep = await upshiftPlanDeposit(upshiftPc({ assetBalance: 10n, previewShares: 0n }), VAULT, { amount: 1n, owner: OWNER });
  assert.deepEqual(byCode(dep, 'AMOUNT_TOO_LOW'), {
    code: 'AMOUNT_TOO_LOW', message: 'Deposit would mint zero shares', available: '0', required: '1', decimals: 18,
  });
  const red = await upshiftPlanRedeem(upshiftPc({ shares: 5n, assetsAmount: 0n }), VAULT, { shares: 1n, owner: OWNER, instant: true });
  assert.deepEqual(byCode(red, 'AMOUNT_TOO_LOW'), {
    code: 'AMOUNT_TOO_LOW', message: 'Redemption nets zero assets after fees', available: '0', required: '1', decimals: 6,
  });
});

test('upshift planRedeem: INSUFFICIENT_SHARES and WITHDRAWAL_LIMIT carry amounts', async () => {
  const pc = upshiftPc({ shares: 5n, maxWithdrawalAmount: 70n, assetsAmount: 80n });
  const plan = await upshiftPlanRedeem(pc, VAULT, { shares: 6n, owner: OWNER });
  assert.deepEqual(byCode(plan, 'INSUFFICIENT_SHARES'), {
    code: 'INSUFFICIENT_SHARES',
    message: 'Owner holds 5 shares, needs 6',
    available: '5', required: '6', decimals: 18,
  });
  assert.deepEqual(byCode(plan, 'WITHDRAWAL_LIMIT'), {
    code: 'WITHDRAWAL_LIMIT',
    message: 'Redemption is 80 reference units, per-tx max is 70',
    available: '70', required: '80', decimals: 6,
  });
});
