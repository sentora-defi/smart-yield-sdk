import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  decodeFunctionData, getAddress, zeroAddress, zeroHash,
} from 'viem';
import { morphoVaultAbi, gateAbi, erc20Abi as morphoErc20Abi } from '../../packages/vaults-morpho/src/abi.ts';
import { tokenizedVaultAbi, whitelistAbi } from '../../packages/vaults-upshift-financial/src/abi.ts';
import {
  boringVaultAbi, tellerAbi, accountantAbi, boringQueueAbi, rolesAuthorityAbi, erc20Abi as boringErc20Abi,
  TELLER_DEPOSIT_SELECTOR, QUEUE_REQUEST_WITHDRAW_SELECTOR,
} from '../../packages/vaults-boring/src/abi.ts';
import { findCommand } from '../../packages/vaults-cli/src/registry.ts';
import { finalizeResult } from '../../packages/vaults-cli/src/result.ts';
import { toCliError } from '../../packages/vaults-cli/src/errors.ts';
import { STUB_VAULTS, startYieldsStub } from './yields-stub.mjs';
import { RPC_INTERNAL, startRpc } from './fakes.mjs';

const CLI_BUNDLE = fileURLToPath(new URL('../../packages/vaults-cli/dist/cli.mjs', import.meta.url));
const CLI_SRC = fileURLToPath(new URL('../../packages/vaults-cli/src/cli.ts', import.meta.url));
const ARGV = process.env.NODE_V8_COVERAGE ? ['--import', 'tsx', CLI_SRC] : [CLI_BUNDLE];

const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const FUNCTIONS = [
  ...morphoVaultAbi, ...gateAbi, ...morphoErc20Abi, ...tokenizedVaultAbi, ...whitelistAbi,
  ...boringVaultAbi, ...tellerAbi, ...accountantAbi, ...boringQueueAbi, ...rolesAuthorityAbi, ...boringErc20Abi,
].filter((i) => i.type === 'function');

async function withRpc(t, reads, opts) {
  const rpc = await startRpc(reads, { abi: FUNCTIONS, ...opts });
  t.after(() => rpc.close());
  return rpc;
}

function run(family, name, rpc, flags) {
  return findCommand(family, name).run({ 'rpc-url': rpc.url, ...flags });
}

async function rejectsWith(promise, code, pattern) {
  const err = await promise.then(() => assert.fail('expected a rejection'), (e) => toCliError(e));
  assert.equal(err.code, code, err.message);
  if (pattern) assert.match(err.message, pattern);
  return err;
}

/** async spawn: the RPC fake lives in this process, so spawnSync would deadlock it */
async function cli(args, envOverride = {}) {
  const env = { ...process.env, VAULTS_RPC_URL: '', SENTORA_RPC_URL: '', ETH_RPC_URL: '', ...envOverride };
  for (const k of Object.keys(env)) if (env[k] === '') delete env[k];
  const child = spawn(process.execPath, [...ARGV, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  const [code] = await once(child, 'close');
  let json, error;
  try { json = JSON.parse(stdout); } catch { /* not JSON */ }
  try { error = JSON.parse(stderr)?.error; } catch { /* not JSON */ }
  return { code, stdout, stderr, json, error };
}

const codes = (plan) => plan.blockers.map((b) => b.code);

const M_VAULT = '0x' + 'cc'.repeat(20);
const M_ASSET = '0x' + 'aa'.repeat(20);
const OWNER = '0x' + 'bb'.repeat(20);
const RECEIVER = '0x' + 'dd'.repeat(20);
const GATE = '0x' + '04'.repeat(20);

function morphoReads(over = {}) {
  return {
    [`${M_VAULT}.symbol`]: 'mUSDC',
    [`${M_VAULT}.decimals`]: 18,
    [`${M_VAULT}.asset`]: M_ASSET,
    [`${M_VAULT}.totalAssets`]: 1_500_000n,
    [`${M_VAULT}.balanceOf`]: 500n,
    [`${M_VAULT}.maxWithdraw`]: 400n,
    [`${M_VAULT}.convertToAssets`]: (args) => args[0] * 2n,
    [`${M_VAULT}.previewDeposit`]: (args) => args[0] * 3n,
    [`${M_VAULT}.previewRedeem`]: (args) => args[0] * 2n,
    [`${M_ASSET}.symbol`]: 'USDC',
    [`${M_ASSET}.decimals`]: 6,
    [`${M_ASSET}.balanceOf`]: 5_000_000n,
    [`${M_ASSET}.allowance`]: 0n,
    ...over,
  };
}

test('morpho meta reads V1 metadata and gains formatted twins', async (t) => {
  const rpc = await withRpc(t, morphoReads());
  const meta = await run('morpho', 'meta', rpc, { vault: M_VAULT });
  assert.equal(meta.isV2, false);
  assert.equal(meta.totalAssets, 1_500_000n);
  assert.equal(rpc.requests.some((r) => r.method === 'eth_call' && r.params[0].to.toLowerCase() === MULTICALL3), true);
  assert.deepEqual(finalizeResult(meta).payload.formatted, { totalAssets: '1.5' });
});

test('morpho position: asset from meta or from --asset', async (t) => {
  const rpc = await withRpc(t, morphoReads({ [`${M_ASSET}.allowance`]: 9n }));
  const pos = await run('morpho', 'position', rpc, { vault: M_VAULT, owner: OWNER });
  assert.deepEqual(pos, {
    vault: M_VAULT, owner: OWNER, asset: getAddress(M_ASSET), shares: 500n, assets: 1_000n, assetBalance: 5_000_000n, allowance: 9n, maxWithdrawRaw: 400n,
  });
  const explicit = await run('morpho', 'position', rpc, { vault: M_VAULT, owner: OWNER, asset: M_ASSET });
  assert.deepEqual(explicit, { ...pos, asset: M_ASSET });
});

test('morpho gates: a V2 send-assets gate denying the user blocks deposits only', async (t) => {
  const rpc = await withRpc(t, morphoReads({
    [`${M_VAULT}.receiveSharesGate`]: zeroAddress,
    [`${M_VAULT}.sendSharesGate`]: zeroAddress,
    [`${M_VAULT}.receiveAssetsGate`]: zeroAddress,
    [`${M_VAULT}.sendAssetsGate`]: GATE,
    [`${GATE}.canSendAssets`]: false,
  }));
  assert.deepEqual(await run('morpho', 'gates', rpc, { vault: M_VAULT, owner: OWNER }), {
    vault: M_VAULT, user: OWNER, gated: true, canDeposit: false, canWithdraw: true,
  });
});

test('morpho gates: V1 reverting gate getters read as ungated with and without multicall', async (t) => {
  const rpc = await withRpc(t, morphoReads());
  const ungated = { vault: M_VAULT, user: OWNER, gated: false, canDeposit: true, canWithdraw: true };
  assert.deepEqual(await run('morpho', 'gates', rpc, { vault: M_VAULT, owner: OWNER }), ungated);
  assert.deepEqual(await run('morpho', 'gates', rpc, { vault: M_VAULT, owner: OWNER, 'no-multicall': true }), ungated);
});

test('morpho gates: a -32603 on a gate getter is RPC_ERROR (exit 4), not an ungated vault', async (t) => {
  const rpc = await withRpc(t, morphoReads({
    [`${M_VAULT}.receiveSharesGate`]: zeroAddress,
    [`${M_VAULT}.sendSharesGate`]: zeroAddress,
    [`${M_VAULT}.receiveAssetsGate`]: zeroAddress,
    [`${M_VAULT}.sendAssetsGate`]: RPC_INTERNAL,
  }));
  await rejectsWith(run('morpho', 'gates', rpc, { vault: M_VAULT, owner: OWNER, 'no-multicall': true }), 'RPC_ERROR');
  const r = await cli(['morpho', 'gates', '--vault', M_VAULT, '--owner', OWNER, '--rpc-url', rpc.url]);
  assert.equal(r.code, 4, r.stderr);
  assert.equal(r.error.code, 'RPC_ERROR');
});

test('a genuine revert is CONTRACT_ERROR and detect skips it, with and without multicall; -32603 stays RPC_ERROR', async (t) => {
  const BORING = '0x' + '11'.repeat(20);
  const rpc = await withRpc(t, { [`${BORING}.hook`]: '0x' + '22'.repeat(20) }, { deployed: [BORING] });
  for (const extra of [[], ['--no-multicall']]) {
    const detected = await cli(['detect', '--vault', BORING, '--rpc-url', rpc.url, ...extra]);
    assert.equal(detected.code, 0, detected.stderr);
    assert.equal(detected.json.family, 'boring');
    const meta = await cli(['morpho', 'meta', '--vault', BORING, '--rpc-url', rpc.url, ...extra]);
    assert.equal(meta.code, 6, meta.stderr);
    assert.equal(meta.error.code, 'CONTRACT_ERROR');
  }
  const flaky = await withRpc(t, { [`${BORING}.asset`]: RPC_INTERNAL, [`${BORING}.hook`]: '0x' + '22'.repeat(20) });
  for (const extra of [[], ['--no-multicall']]) {
    const r = await cli(['detect', '--vault', BORING, '--rpc-url', flaky.url, ...extra]);
    assert.equal(r.code, 4, r.stderr);
    assert.equal(r.error.code, 'RPC_ERROR');
  }
});

test('morpho plan-deposit: approve + deposit to --receiver, --human scales by the asset decimals', async (t) => {
  const rpc = await withRpc(t, morphoReads());
  const plan = await run('morpho', 'plan-deposit', rpc, { vault: M_VAULT, owner: OWNER, receiver: RECEIVER, assets: '1.5', human: true });
  assert.deepEqual(codes(plan), []);
  assert.equal(plan.expected.shares, '4500000');
  assert.equal(plan.steps.length, 2);
  assert.equal(decodeFunctionData({ abi: morphoVaultAbi, data: plan.steps[1].data }).args[1], getAddress(RECEIVER));
  const { payload, blocked } = finalizeResult(plan);
  assert.equal(blocked, false);
  assert.equal(typeof payload.schemaVersion, 'number');
  assert.deepEqual(payload.expectedFormatted, { shares: '0.0000000000045' });
});

test('morpho plan-deposit: insufficient balance is a blocked plan', async (t) => {
  const rpc = await withRpc(t, morphoReads({ [`${M_ASSET}.balanceOf`]: 1n }));
  const plan = await run('morpho', 'plan-deposit', rpc, { vault: M_VAULT, owner: OWNER, assets: '100' });
  assert.deepEqual(codes(plan), ['INSUFFICIENT_BALANCE']);
  assert.equal(finalizeResult(plan).blocked, true);
});

test('morpho plan-redeem: --human shares use the vault decimals; holding too few is blocked', async (t) => {
  const rpc = await withRpc(t, morphoReads());
  const plan = await run('morpho', 'plan-redeem', rpc, { vault: M_VAULT, owner: OWNER, shares: '0.0000000000000001', human: true });
  assert.deepEqual(codes(plan), []);
  assert.equal(plan.expected.assets, '200');
  assert.deepEqual(finalizeResult(plan).payload.expectedFormatted, { assets: '0.0002' });
  const blocked = await run('morpho', 'plan-redeem', rpc, { vault: M_VAULT, owner: OWNER, shares: '501' });
  assert.deepEqual(codes(blocked), ['INSUFFICIENT_SHARES']);
});

test('amount flags: base units by default, decimals with --human, precision capped by token decimals', async (t) => {
  const rpc = await withRpc(t, morphoReads());
  const base = { vault: M_VAULT, owner: OWNER };
  let err = await rejectsWith(run('morpho', 'plan-deposit', rpc, { ...base, assets: '1.5' }), 'USAGE', /base units/);
  assert.match(err.hint, /--human/);
  await rejectsWith(run('morpho', 'plan-deposit', rpc, { ...base, assets: '1e6', human: true }), 'USAGE', /must be a decimal number/);
  err = await rejectsWith(run('morpho', 'plan-deposit', rpc, { ...base, assets: '1.1234567', human: true }), 'USAGE', /7 fractional digits but the token has 6 decimals/);
  await rejectsWith(run('morpho', 'plan-deposit', rpc, base), 'USAGE', /Missing required flag --assets/);
});

test('an amount that overflows the uint256 ABI slot is a usage error, not a revert', async (t) => {
  const rpc = await withRpc(t, morphoReads());
  const err = await rejectsWith(run('morpho', 'plan-deposit', rpc, { vault: M_VAULT, owner: OWNER, assets: (2n ** 256n).toString() }), 'USAGE');
  assert.match(err.hint, /out of range for the contract ABI slot/);
});

const U_VAULT = '0x' + '74'.repeat(20);
const LP = '0x' + '75'.repeat(20);
const U_ASSET = '0x' + 'a1'.repeat(20);
const ALT = '0x' + 'ab'.repeat(20);
const SENDERS_WL = '0x' + '5e'.repeat(20);
const ASSETS_WL = '0x' + 'a5'.repeat(20);

function upshiftReads(over = {}) {
  return {
    [`${U_VAULT}.asset`]: U_ASSET,
    [`${U_VAULT}.lpTokenAddress`]: LP,
    [`${U_VAULT}.getTotalAssets`]: 1_000_000n,
    [`${U_VAULT}.getSharePrice`]: 1_050_000n,
    [`${U_VAULT}.depositsPaused`]: false,
    [`${U_VAULT}.withdrawalsPaused`]: false,
    [`${U_VAULT}.depositCap`]: 10_000_000_000n,
    [`${U_VAULT}.maxDepositAmount`]: 5_000_000_000n,
    [`${U_VAULT}.maxWithdrawalAmount`]: 5_000_000_000n,
    [`${U_VAULT}.instantRedemptionFee`]: 50n,
    [`${U_VAULT}.withdrawalFee`]: 10n,
    [`${U_VAULT}.lagDuration`]: 86_400n,
    [`${U_VAULT}.sendersWhitelistAddress`]: zeroAddress,
    [`${U_VAULT}.assetsWhitelistAddress`]: ASSETS_WL,
    [`${U_VAULT}.previewDeposit`]: (args) => [args[1] * 2n, args[1]],
    [`${U_VAULT}.previewRedemption`]: (args) => [args[0] * 3n, args[1] ? args[0] * 3n - 2n : args[0] * 3n - 1n],
    [`${U_VAULT}.getWithdrawalEpoch`]: [2026n, 11n, 3n, 1_800n],
    [`${U_VAULT}.getBurnableAmountByReceiver`]: 40n,
    [`${U_VAULT}.getScheduledTransactionsByDate`]: [2n, 1_500n],
    [`${LP}.symbol`]: 'upUSDC',
    [`${LP}.decimals`]: 18,
    [`${LP}.totalSupply`]: 900n * 10n ** 18n,
    [`${LP}.balanceOf`]: 10n ** 18n,
    [`${LP}.allowance`]: 0n,
    [`${U_ASSET}.symbol`]: 'USDC',
    [`${U_ASSET}.decimals`]: 6,
    [`${U_ASSET}.balanceOf`]: 1_000_000n,
    [`${U_ASSET}.allowance`]: 0n,
    [`${ALT}.decimals`]: 8,
    [`${ALT}.balanceOf`]: 10n ** 8n,
    [`${ALT}.allowance`]: 0n,
    [`${ASSETS_WL}.isWhitelisted`]: true,
    [`${SENDERS_WL}.isWhitelisted`]: false,
    ...over,
  };
}

test('upshift_evm meta: every base-unit amount gets a formatted twin', async (t) => {
  const rpc = await withRpc(t, upshiftReads());
  const meta = await run('upshift_evm', 'meta', rpc, { vault: U_VAULT });
  assert.equal(meta.lpToken, getAddress(LP));
  assert.deepEqual(finalizeResult(meta).payload.formatted, {
    totalAssets: '1', sharePrice: '1.05', depositCap: '10000', maxDepositAmount: '5000', maxWithdrawalAmount: '5000', totalSupply: '900',
  });
});

test('upshift_evm position: reference asset by default, --asset overrides', async (t) => {
  const rpc = await withRpc(t, upshiftReads());
  const pos = await run('upshift_evm', 'position', rpc, { vault: U_VAULT, owner: OWNER });
  assert.deepEqual(pos, {
    vault: U_VAULT, owner: OWNER, asset: getAddress(U_ASSET), shares: 10n ** 18n, assets: 3n * 10n ** 18n,
    assetBalance: 1_000_000n, allowance: 0n, shareAllowance: 0n,
  });
  const alt = await run('upshift_evm', 'position', rpc, { vault: U_VAULT, owner: OWNER, asset: ALT });
  assert.equal(alt.asset, ALT);
  assert.equal(alt.assetBalance, 10n ** 8n);
});

test('upshift_evm gates: senders whitelist and a non-reference --asset', async (t) => {
  const rpc = await withRpc(t, upshiftReads({ [`${U_VAULT}.sendersWhitelistAddress`]: SENDERS_WL, [`${ASSETS_WL}.isWhitelisted`]: false }));
  assert.deepEqual(await run('upshift_evm', 'gates', rpc, { vault: U_VAULT, owner: OWNER, asset: ALT }), {
    vault: U_VAULT, user: OWNER, sendersGated: true, canSend: false, assetAllowed: false,
  });
  assert.deepEqual(await run('upshift_evm', 'gates', rpc, { vault: U_VAULT, owner: OWNER }), {
    vault: U_VAULT, user: OWNER, sendersGated: true, canSend: false, assetAllowed: true,
  });
});

test('upshift_evm plan-deposit: --human uses the reference asset decimals, or the --asset decimals', async (t) => {
  const rpc = await withRpc(t, upshiftReads());
  const plan = await run('upshift_evm', 'plan-deposit', rpc, { vault: U_VAULT, owner: OWNER, amount: '0.5', human: true });
  assert.deepEqual(codes(plan), []);
  assert.deepEqual(plan.expected, { shares: '1000000', amountInReferenceTokens: '500000' });
  assert.deepEqual(finalizeResult(plan).payload.expectedFormatted, { shares: '0.000000000001', amountInReferenceTokens: '0.5' });
  assert.equal(plan.steps.length, 2);

  const alt = await run('upshift_evm', 'plan-deposit', rpc, { vault: U_VAULT, owner: OWNER, receiver: RECEIVER, asset: ALT, amount: '0.25', human: true });
  assert.deepEqual(codes(alt), []);
  assert.equal(alt.context.assetIn, ALT);
  assert.equal(alt.expected.amountInReferenceTokens, '25000000');
});

test('upshift_evm plan-redeem: queued by default, --instant burns directly; --human uses LP decimals', async (t) => {
  const rpc = await withRpc(t, upshiftReads());
  const queued = await run('upshift_evm', 'plan-redeem', rpc, { vault: U_VAULT, owner: OWNER, shares: '0.000000001', human: true });
  assert.equal(queued.action, 'requestRedeem');
  assert.deepEqual(codes(queued), []);
  assert.deepEqual(queued.context.claimDate, { year: 2026, month: 11, day: 3 });
  assert.equal(queued.steps.length, 2);
  assert.deepEqual(finalizeResult(queued).payload.expectedFormatted, { assets: '3000', assetsAfterFee: '2999.999999' });

  const instant = await run('upshift_evm', 'plan-redeem', rpc, { vault: U_VAULT, owner: OWNER, receiver: RECEIVER, shares: '1000', instant: true });
  assert.equal(instant.action, 'instantRedeem');
  assert.deepEqual(codes(instant), []);
  assert.equal(instant.steps.length, 1);
});

test('upshift_evm plan-claim: claim date flags are validated, a matured claim plans one step', async (t) => {
  const rpc = await withRpc(t, upshiftReads(), { blockTimestamp: 2_000n });
  const plan = await run('upshift_evm', 'plan-claim', rpc, { vault: U_VAULT, owner: OWNER, year: '2026', month: '11', day: '3' });
  assert.deepEqual(codes(plan), []);
  assert.equal(plan.expected.shares, '40');
  assert.equal(plan.steps.length, 1);
  assert.deepEqual(plan.context.claimDate, { year: 2026, month: 11, day: 3 });

  const early = await withRpc(t, upshiftReads(), { blockTimestamp: 1_000n });
  const tooEarly = await run('upshift_evm', 'plan-claim', early, { vault: U_VAULT, owner: OWNER, receiver: RECEIVER, year: '2026', month: '11', day: '3' });
  assert.deepEqual(codes(tooEarly), ['TOO_EARLY']);

  const date = { vault: U_VAULT, owner: OWNER, year: '2026', month: '11', day: '3' };
  await rejectsWith(run('upshift_evm', 'plan-claim', rpc, { ...date, month: '13' }), 'USAGE', /--month must be an integer in \[1, 12\], got '13'/);
  await rejectsWith(run('upshift_evm', 'plan-claim', rpc, { ...date, year: '2023' }), 'USAGE', /--year/);
  await rejectsWith(run('upshift_evm', 'plan-claim', rpc, { ...date, day: '1.5' }), 'USAGE', /--day/);
  await rejectsWith(run('upshift_evm', 'plan-claim', rpc, { ...date, day: undefined }), 'USAGE', /Missing required flag --day/);
});

test('upshift_evm epoch: claim date of a redemption requested now', async (t) => {
  const rpc = await withRpc(t, upshiftReads());
  assert.deepEqual(await run('upshift_evm', 'epoch', rpc, { vault: U_VAULT }), { year: 2026, month: 11, day: 3, claimableEpoch: 1_800n });
});

const B_VAULT = '0x' + '11'.repeat(20);
const AUTH = '0x' + '22'.repeat(20);
const TELLER = '0x' + '33'.repeat(20);
const ACC = '0x' + '44'.repeat(20);
const QUEUE = '0x' + '55'.repeat(20);
const B_ASSET = '0x' + 'ba'.repeat(20);
const ONE = 10n ** 18n;

function boringReads(over = {}) {
  return {
    [`${B_VAULT}.authority`]: AUTH,
    [`${B_VAULT}.hook`]: TELLER,
    [`${B_VAULT}.decimals`]: 18,
    [`${B_VAULT}.balanceOf`]: 5n * ONE,
    [`${B_VAULT}.allowance`]: 0n,
    [`${TELLER}.vault`]: B_VAULT,
    [`${TELLER}.accountant`]: ACC,
    [`${TELLER}.isPaused`]: false,
    [`${TELLER}.assetData`]: [true, true, 0],
    [`${TELLER}.shareUnlockTime`]: 0n,
    [`${TELLER}.shareLockPeriod`]: 0n,
    [`${AUTH}.canCall`]: (args) => args[2] === TELLER_DEPOSIT_SELECTOR || args[2] === QUEUE_REQUEST_WITHDRAW_SELECTOR,
    [`${AUTH}.isCapabilityPublic`]: true,
    [`${AUTH}.getRolesWithCapability`]: zeroHash,
    [`${ACC}.getRateInQuoteSafe`]: 1_000_000n,
    [`${QUEUE}.boringVault`]: B_VAULT,
    [`${QUEUE}.authority`]: AUTH,
    [`${QUEUE}.withdrawAssets`]: [true, 86_400, 3_600, 1, 30, 10n],
    [`${QUEUE}.isPaused`]: false,
    [`${QUEUE}.previewAssetsOut`]: 999_000n,
    [`${B_ASSET}.decimals`]: 6,
    [`${B_ASSET}.balanceOf`]: 10_000_000n,
    [`${B_ASSET}.allowance`]: 0n,
    ...over,
  };
}

test('boring discover: an explicit --queue is verified, without one the authority scan runs from --from-block', async (t) => {
  const rpc = await withRpc(t, boringReads());
  const known = await run('boring', 'discover', rpc, { vault: B_VAULT, queue: QUEUE });
  assert.deepEqual(known, {
    config: { vault: B_VAULT, teller: TELLER, accountant: ACC, queue: QUEUE, rolesAuthority: AUTH, chainId: 1 },
    queueUnknown: false, queueDeprecated: false, warnings: [],
  });
  assert.equal(rpc.requests.some((r) => r.method === 'eth_getLogs'), false);

  const scanned = await run('boring', 'discover', rpc, { vault: B_VAULT, teller: TELLER, 'from-block': '100' });
  assert.equal(scanned.queueUnknown, true);
  assert.equal(scanned.config.queue, zeroAddress);
  assert.match(scanned.warnings.join(' '), /No BoringOnChainQueue found/);
  const getLogs = rpc.requests.filter((r) => r.method === 'eth_getLogs');
  assert.equal(getLogs.length > 0, true);
  assert.equal(getLogs.every((r) => r.params[0].fromBlock === '0x64'), true);

  await rejectsWith(run('boring', 'discover', rpc, { vault: B_VAULT, 'from-block': 'latest' }), 'USAGE', /--from-block must be an unsigned integer/);
});

test('boring position: priced via the accountant, config and warnings attached', async (t) => {
  const rpc = await withRpc(t, boringReads({ [`${B_VAULT}.allowance`]: 7n }));
  const pos = await run('boring', 'position', rpc, { vault: B_VAULT, owner: OWNER, asset: B_ASSET, queue: QUEUE });
  assert.deepEqual(pos, {
    vault: B_VAULT, owner: OWNER, asset: B_ASSET, shares: 5n * ONE, assets: 5_000_000n, assetBalance: 10_000_000n,
    vaultAllowance: 0n, queueShareAllowance: 7n,
    config: { vault: B_VAULT, teller: TELLER, accountant: ACC, queue: QUEUE, rolesAuthority: AUTH, chainId: 1 },
    warnings: [],
  });
});

test('boring plan-deposit: --human amount, --slippage-bps guard, discovery attached to the plan', async (t) => {
  const rpc = await withRpc(t, boringReads());
  const plan = await run('boring', 'plan-deposit', rpc, {
    vault: B_VAULT, owner: OWNER, asset: B_ASSET, amount: '2', human: true, 'slippage-bps': '100',
  });
  assert.deepEqual(codes(plan), []);
  assert.deepEqual(plan.expected, { shares: (2n * ONE).toString(), minimumMint: ((2n * ONE * 9_900n) / 10_000n).toString() });
  assert.match(plan.warnings.join(' '), /No BoringOnChainQueue found/);
  assert.equal(plan.context.discovered.teller, TELLER);
  assert.deepEqual(finalizeResult(plan).payload.expectedFormatted, { shares: '2', minimumMint: '1.98' });
});

test('boring plan-deposit: --slippage-bps 10000 is rejected before any RPC call', async (t) => {
  const rpc = await withRpc(t, boringReads());
  await rejectsWith(
    run('boring', 'plan-deposit', rpc, { vault: B_VAULT, owner: OWNER, asset: B_ASSET, amount: '1', 'slippage-bps': '10000' }),
    'USAGE', /--slippage-bps must be <= 9999/,
  );
  assert.equal(rpc.requests.length, 0);
});

test('boring plan-withdraw: --human shares, explicit discount and deadline', async (t) => {
  const rpc = await withRpc(t, boringReads());
  const plan = await run('boring', 'plan-withdraw', rpc, {
    vault: B_VAULT, owner: OWNER, 'asset-out': B_ASSET, shares: '1.5', human: true, queue: QUEUE,
    'discount-bps': '5', 'seconds-to-deadline': '7200',
  });
  assert.deepEqual(codes(plan), []);
  assert.equal(plan.context.discountBps, 5);
  assert.equal(plan.context.secondsToDeadline, 7_200);
  assert.equal(plan.context.discovered.queue, QUEUE);
  assert.equal(plan.steps.length, 2);
  assert.equal(decodeFunctionData({ abi: boringQueueAbi, data: plan.steps[1].data }).args[1], 15n * 10n ** 17n);
  assert.deepEqual(finalizeResult(plan).payload.expectedFormatted, { assets: '0.999' });
});

test('boring plan-withdraw: bps and deadline flags are bounded by their ABI slots', async (t) => {
  const rpc = await withRpc(t, boringReads());
  const base = { vault: B_VAULT, owner: OWNER, 'asset-out': B_ASSET, shares: '1', queue: QUEUE };
  await rejectsWith(run('boring', 'plan-withdraw', rpc, { ...base, 'discount-bps': '65536' }), 'USAGE', /--discount-bps must be <= 65535/);
  await rejectsWith(run('boring', 'plan-withdraw', rpc, { ...base, 'seconds-to-deadline': '16777216' }), 'USAGE', /--seconds-to-deadline must be <= 16777215/);
  await rejectsWith(run('boring', 'plan-withdraw', rpc, { ...base, 'discount-bps': '-1' }), 'USAGE', /unsigned integer/);
  assert.equal(rpc.requests.length, 0);
});

test('boring plan-withdraw: shares beyond the uint128 queue slot map to a usage error', async (t) => {
  const huge = 2n ** 129n;
  const rpc = await withRpc(t, boringReads({ [`${B_VAULT}.balanceOf`]: huge }));
  const err = await rejectsWith(
    run('boring', 'plan-withdraw', rpc, { vault: B_VAULT, owner: OWNER, 'asset-out': B_ASSET, shares: huge.toString(), queue: QUEUE }),
    'USAGE',
  );
  assert.match(err.hint, /out of range/);
});

test('snapshot --owner: morpho and upshift_evm items carry meta, gates and position', async (t) => {
  const records = [
    { ...STUB_VAULTS[0], chainId: 'eip155:1', contracts: { vault: M_VAULT } },
    { ...STUB_VAULTS[1], chainId: 'eip155:1', contracts: { vault: U_VAULT, receiptToken: LP } },
  ];
  const stub = await startYieldsStub(records);
  t.after(() => stub.close());
  const rpc = await withRpc(t, { ...morphoReads(), ...upshiftReads() });
  const [m, u] = await run('', 'snapshot', rpc, { vault: `${M_VAULT},${U_VAULT}`, owner: OWNER, 'base-url': stub.url });
  assert.equal(m.family, 'morpho');
  assert.equal(m.meta.asset, getAddress(M_ASSET));
  assert.deepEqual(m.gates, { gated: false, canDeposit: true, canWithdraw: true });
  assert.equal(m.position.shares, 500n);
  assert.equal(u.family, 'upshift_evm');
  assert.equal(u.meta.lpToken, getAddress(LP));
  assert.deepEqual(u.gates, { sendersGated: false, canSend: true, assetAllowed: true });
  assert.equal(u.position.shares, 10n ** 18n);

  for (const vault of [M_VAULT, U_VAULT]) {
    const solo = await run('', 'snapshot', rpc, { vault, 'base-url': stub.url });
    assert.equal(typeof solo.meta, 'object');
    assert.equal('gates' in solo || 'position' in solo, false);
  }
});

test('CLI: a blocked plan prints the plan and exits 7; --verbose logs RPC calls to stderr only', async (t) => {
  const rpc = await withRpc(t, morphoReads({ [`${M_ASSET}.balanceOf`]: 1n }));
  const r = await cli(['morpho', 'plan-deposit', '--vault', M_VAULT, '--owner', OWNER, '--assets', '100', '--rpc-url', rpc.url, '--verbose']);
  assert.equal(r.code, 7);
  assert.equal(typeof r.json.schemaVersion, 'number');
  assert.deepEqual(codes(r.json), ['INSUFFICIENT_BALANCE']);
  assert.match(r.stderr, /# rpc #\d+ eth_call → 0xca11bde05977b3631167028862be2a173976ca11 \d+ms/i);
  assert.match(r.stderr, /# rpc #\d+ eth_chainId \d+ms/);
  assert.match(r.stderr, /BLOCKED \(exit 7\)/);
});

test('CLI: --no-multicall reads directly, --human amounts are logged, a clean plan exits 0', async (t) => {
  const rpc = await withRpc(t, morphoReads());
  const r = await cli([
    'morpho', 'plan-deposit', '--vault', M_VAULT, '--owner', OWNER, '--assets', '1.5', '--human',
    '--rpc-url', rpc.url, '--no-multicall', '--verbose', '--timeout', '5000',
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.expectedFormatted, { shares: '0.0000000000045' });
  assert.match(r.stderr, /multicall off/);
  assert.match(r.stderr, /--assets: 1\.5 human × 10\^6/);
  assert.match(r.stderr, /plan-deposit: ok/);
  assert.equal(rpc.requests.some((q) => q.method === 'eth_call' && q.params[0].to.toLowerCase() === MULTICALL3), false);
});

test('CLI: --output text flattens a plan into path=value lines', async (t) => {
  const rpc = await withRpc(t, upshiftReads());
  const r = await cli(['upshift_evm', 'epoch', '--vault', U_VAULT, '--rpc-url', rpc.url, '--output', 'text']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'year=2026\nmonth=11\nday=3\nclaimableEpoch=1800\n');
});

test('CLI: out-of-range ABI input exits 2 with the ABI-slot hint', async (t) => {
  const rpc = await withRpc(t, morphoReads());
  const r = await cli(['morpho', 'plan-deposit', '--vault', M_VAULT, '--owner', OWNER, '--assets', (2n ** 256n).toString(), '--rpc-url', rpc.url]);
  assert.equal(r.code, 2);
  assert.equal(r.error.code, 'USAGE');
  assert.match(r.error.hint, /out of range for the contract ABI slot/);
});
