/**
 * Pure-logic SDK tests (no network beyond a loopback JSON-RPC fake). Runs
 * under `node --import tsx` so the TypeScript package sources import directly.
 */
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import {
  BaseError, ExecutionRevertedError, HttpRequestError, createPublicClient, createWalletClient, custom, encodeAbiParameters, encodeEventTopics,
  encodeFunctionData, erc20Abi, http, parseAbi, parseAbiParameters, zeroAddress,
} from 'viem';
import { approveNeedsReset, blocked, isContractRevert, isGasCapError, isTransportFailure, orOnRevert, sendSimulated, TransactionFailedError, zeroValue } from '../../packages/vaults-plan/src/index.ts';
import { encodeDeposit, encodeRequestRedeem, encodeClaim } from '../../packages/vaults-upshift-financial/src/encode.ts';
import { planDeposit as upshiftPlanDeposit } from '../../packages/vaults-upshift-financial/src/plan.ts';
import { planDeposit as morphoPlanDeposit } from '../../packages/vaults-morpho/src/plan.ts';
import { planDeposit as boringPlanDeposit } from '../../packages/vaults-boring/src/plan.ts';
import { claimDateForRequest, getPendingWithdrawals, getPendingWithdrawalsFromActivity } from '../../packages/vaults-upshift-financial/src/core.ts';
import { deposit as boringDeposit, requestWithdraw } from '../../packages/vaults-boring/src/core.ts';
import { boringQueueAbi, tellerAbi, tellerDepositV2Abi } from '../../packages/vaults-boring/src/abi.ts';
import { morphoVaultAbi } from '../../packages/vaults-morpho/src/abi.ts';
import { evmChainId, toCaip2ChainId } from '../../packages/yields-client/src/index.ts';
import { toCliError } from '../../packages/vaults-cli/src/errors.ts';
import { RPC_INTERNAL, revertError, rpcInternalError, startRpc, zeroDataError } from './fakes.mjs';

const OWNER = '0x1111111111111111111111111111111111111100';
const LAG = 259200n;
const ts = (iso) => BigInt(Date.parse(iso) / 1000);

const req = (iso, blockNumber) => ({ requestedAt: ts(iso), blockNumber });

test('claimDateForRequest matches the dates requestRedeem assigned on mainnet', () => {
  assert.deepEqual(claimDateForRequest(ts('2026-10-20T09:34:23Z'), LAG), { year: 2026, month: 10, day: 23 });
  assert.deepEqual(claimDateForRequest(ts('2026-10-22T12:18:23Z'), LAG), { year: 2026, month: 10, day: 25 });
});

test('claimDateForRequest: requests in the last 5 minutes of a day land one day later, as on mainnet', () => {
  // tx 0x17b8f93d… mined 2026-04-14T23:56:23Z and tx 0x122ba1d4… mined 2026-06-14T23:55:59Z were both paid out for day +4
  assert.deepEqual(claimDateForRequest(ts('2026-04-14T23:56:23Z'), LAG), { year: 2026, month: 4, day: 18 });
  assert.deepEqual(claimDateForRequest(ts('2026-06-14T23:55:59Z'), LAG), { year: 2026, month: 6, day: 18 });
  assert.deepEqual(claimDateForRequest(ts('2026-06-14T23:54:59Z'), LAG), { year: 2026, month: 6, day: 17 });
  assert.deepEqual(claimDateForRequest(ts('2026-12-29T12:00:00Z'), LAG), { year: 2027, month: 1, day: 1 });
});

function vaultStub({ now, burnable, epochAtBlock = {}, archive = true }) {
  const readable = (blockNumber) => archive === true || (Array.isArray(archive) && archive.includes(blockNumber));
  const reads = [];
  const pc = {
    getBlock: async () => ({ timestamp: now }),
    readContract: async ({ functionName, args, blockNumber }) => {
      reads.push(functionName);
      if (functionName === 'lagDuration') return LAG;
      if (functionName === 'getWithdrawalEpoch') {
        if (!readable(blockNumber)) throw new Error('missing trie node');
        const [y, m, d] = epochAtBlock[blockNumber];
        return [BigInt(y), BigInt(m), BigInt(d), BigInt(Date.UTC(y, m - 1, d) / 1000)];
      }
      const [y, m, d] = args.map(Number);
      const key = `${y}-${m}-${d}`;
      if (functionName === 'getBurnableAmountByReceiver') return burnable[key] ?? 0n;
      if (functionName === 'getScheduledTransactionsByDate') return [1n, BigInt(Date.UTC(y, m - 1, d) / 1000)];
      throw new Error(`unexpected read ${functionName}`);
    },
  };
  return { pc, reads };
}

test('getPendingWithdrawals keeps unpaid dates however old, drops paid ones, oldest first', async () => {
  const { pc } = vaultStub({
    now: ts('2026-10-22T12:00:00Z'),
    burnable: { '2025-3-4': 7n, '2026-10-25': 5n, '2026-10-23': 0n },
  });
  const pending = await getPendingWithdrawals(pc, OWNER, OWNER, [
    req('2026-10-22T08:00:00Z'),
    req('2026-10-20T08:00:00Z'),
    req('2025-03-01T08:00:00Z'),
  ]);
  assert.deepEqual(pending.map((p) => [p.date, p.shares, p.status]), [
    [{ year: 2025, month: 3, day: 4 }, 7n, 'claimable'],
    [{ year: 2026, month: 10, day: 25 }, 5n, 'pending'],
  ]);
});

test('getPendingWithdrawals reads each date once and turns claimable at the epoch, like planClaim', async () => {
  const epoch = ts('2026-10-25T00:00:00Z');
  const { pc, reads } = vaultStub({ now: epoch, burnable: { '2026-10-25': 9n } });
  const pending = await getPendingWithdrawals(pc, OWNER, OWNER, [req('2026-10-22T08:00:00Z'), req('2026-10-22T09:00:00Z')]);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, 'claimable');
  assert.equal(reads.filter((r) => r === 'getBurnableAmountByReceiver').length, 1);

  const early = vaultStub({ now: epoch - 1n, burnable: { '2026-10-25': 9n } });
  assert.equal((await getPendingWithdrawals(early.pc, OWNER, OWNER, [req('2026-10-22T08:00:00Z')]))[0].status, 'pending');
});

test('getPendingWithdrawals takes the date the vault reports at the request block, not one rebuilt from today\'s timelock', async () => {
  const { pc, reads } = vaultStub({ now: ts('2026-10-22T12:00:00Z'), burnable: { '2026-3-8': 4n }, epochAtBlock: { 100: [2026, 3, 8] } });
  const pending = await getPendingWithdrawals(pc, OWNER, OWNER, [req('2026-03-01T08:00:00Z', 100n)]);
  assert.deepEqual(pending.map((p) => [p.date, p.shares]), [[{ year: 2026, month: 3, day: 8 }, 4n]]);
  assert.ok(!reads.includes('lagDuration'), 'no current-timelock read when every request has a block');
});

test('getPendingWithdrawals throws instead of guessing when the vault cannot be read at a request block', async () => {
  const { pc } = vaultStub({ now: ts('2026-10-22T12:00:00Z'), burnable: { '2026-3-4': 4n }, archive: false });
  await assert.rejects(
    getPendingWithdrawals(pc, OWNER, OWNER, [req('2026-03-01T08:00:00Z', 100n)]),
    (e) => e.name === 'HistoricEpochUnavailableError' && e.blockNumber === 100n && /missing trie node/.test(e.cause.message),
  );
});

test('getPendingWithdrawals reads each request block once, at most 8 at a time', async () => {
  const epochAtBlock = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i, [2026, 3, 4]]));
  const { pc } = vaultStub({ now: ts('2026-10-22T12:00:00Z'), burnable: {}, epochAtBlock });
  let inFlight = 0, peak = 0, calls = 0;
  const read = pc.readContract;
  pc.readContract = async (args) => {
    if (args.functionName !== 'getWithdrawalEpoch') return read(args);
    calls++; peak = Math.max(peak, ++inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight--;
    return read(args);
  };
  await getPendingWithdrawals(pc, OWNER, OWNER, Array.from({ length: 20 }, (_, i) => req('2026-03-01T08:00:00Z', BigInt(i % 10))));
  assert.equal(calls, 10);
  assert.ok(peak <= 8, `peak ${peak}`);
});

test('getPendingWithdrawals with no requests does not touch the chain', async () => {
  const { pc, reads } = vaultStub({ now: 0n, burnable: {} });
  assert.deepEqual(await getPendingWithdrawals(pc, OWNER, OWNER, []), []);
  assert.equal(reads.length, 0);
});

const row = (over) => ({ type: 'WITHDRAW_REQUEST', timestamp: '2026-10-22T12:18:23.000Z', blockNumber: 26248104, id: 'x', ...over });

test('getPendingWithdrawalsFromActivity falls back to the current timelock only for the blocks it cannot read', async () => {
  const rows = [row({ blockNumber: 1, timestamp: '2026-03-01T08:00:00Z' }), row({ blockNumber: 2, timestamp: '2026-10-22T08:00:00Z' }), row({ type: 'DEPOSIT' })];
  const { pc } = vaultStub({
    now: ts('2026-10-22T12:00:00Z'),
    burnable: { '2026-3-4': 4n, '2026-10-29': 6n },
    epochAtBlock: { 2: [2026, 10, 29] },
    archive: [2n],
  });
  const result = await getPendingWithdrawalsFromActivity(pc, OWNER, OWNER, rows);
  assert.equal(result.requestCount, 2);
  assert.deepEqual(result.withdrawals.map((p) => p.date), [{ year: 2026, month: 3, day: 4 }, { year: 2026, month: 10, day: 29 }]);
  assert.deepEqual(result.historicReadErrors.map((e) => [e.name, e.blockNumber, e.cause.message]), [['HistoricEpochUnavailableError', 1n, 'missing trie node']]);
});

const VAULT = '0x2222222222222222222222222222222222222200';
const QUEUE = '0x3333333333333333333333333333333333333300';
const ASSET = '0x4444444444444444444444444444444444444400';
const TX = `0x${'a1'.repeat(32)}`;
const REPLACEMENT_TX = `0x${'b2'.repeat(32)}`;

function mockClients({ pcChain = 1, wcChain = 1, walletTransportChain = wcChain, result = 7n, status = 'success', replaced, logs = [] } = {}) {
  const calls = { simulate: [], write: [] };
  const pc = {
    getChainId: async () => pcChain,
    simulateContract: async (args) => { calls.simulate.push(args); return { result }; },
    waitForTransactionReceipt: async ({ hash, onReplaced }) => {
      if (replaced !== undefined) onReplaced?.({ reason: replaced });
      return { status, transactionHash: replaced === undefined ? hash : REPLACEMENT_TX, logs };
    },
  };
  const wc = {
    account: { address: OWNER, type: 'json-rpc' },
    chain: wcChain === null ? undefined : { id: wcChain },
    getChainId: async () => walletTransportChain,
    writeContract: async (args) => { calls.write.push(args); return TX; },
  };
  return { pc, wc, calls };
}

const depositCall = { address: VAULT, abi: morphoVaultAbi, functionName: 'deposit', args: [5n, OWNER] };

test('chain ids: legacy and CAIP-2 normalize the same way', () => {
  assert.equal(toCaip2ChainId('1'), 'eip155:1');
  assert.equal(toCaip2ChainId('eip155:57073'), 'eip155:57073');
  assert.equal(toCaip2ChainId('Solana'), 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
  assert.equal(toCaip2ChainId('Stellar'), 'stellar:pubnet');
  assert.equal(toCaip2ChainId('solana'), 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
  assert.equal(toCaip2ChainId('1399811149'), 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
  assert.equal(evmChainId('1399811149'), undefined);
  assert.equal(evmChainId('1'), 1);
  assert.equal(evmChainId('eip155:57073'), 57073);
  assert.equal(evmChainId('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'), undefined);
  assert.equal(evmChainId('Stellar'), undefined);
  assert.equal(evmChainId('eip155:0'), undefined);
});

test('plan envelope: blocked() fills empty steps, zeroValue is a decimal string', () => {
  const plan = blocked({ family: 'x', action: 'y', vault: OWNER, expected: {}, blockers: [{ code: 'A', message: 'b' }], warnings: [], context: {} });
  assert.deepEqual(plan.steps, []);
  assert.equal(zeroValue, '0');
});

test('isContractRevert: revert and zero data only; -32603, transport and non-errors are not reverts', () => {
  assert.equal(isContractRevert(revertError()), true);
  assert.equal(isContractRevert(zeroDataError()), true);
  assert.equal(isContractRevert(rpcInternalError()), false);
  assert.equal(isContractRevert(new Error('execution reverted')), false);
  assert.equal(isContractRevert(Object.assign(new Error('x'), { name: 'ContractFunctionRevertedError' })), true);
  for (const v of [undefined, null, 'ContractFunctionRevertedError', { name: 'ContractFunctionRevertedError' }]) {
    assert.equal(isContractRevert(v), false);
  }
  const cyclic = new Error('loop');
  cyclic.cause = cyclic;
  assert.equal(isContractRevert(cyclic), false);
});

test('an empty revert sent as -32000 without data is a revert; short return data and transport errors are not', async (t) => {
  const REVERTS = '0x' + '0c'.repeat(20);
  const SHORT = '0x' + '0d'.repeat(20);
  const LIMITED = '0x' + '0e'.repeat(20);
  const GAS_CAP = '0x' + '0f'.repeat(20);
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { id, params } = JSON.parse(body);
      const reply = params[0].to === REVERTS ? { error: { code: -32000, message: 'execution reverted' } }
        : params[0].to === LIMITED ? { error: { code: -32005, message: 'execution reverted: request limit reached' } }
        : params[0].to === GAS_CAP ? { error: { code: -32000, message: 'gas required exceeds allowance (550000000)' } }
        : { result: '0x01' };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id, ...reply }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const pc = createPublicClient({ transport: http(`http://127.0.0.1:${server.address().port}`, { retryCount: 0 }) });
  const abi = parseAbi(['function f() view returns (address)']);
  const read = (address) => pc.readContract({ address, abi, functionName: 'f' });

  const reverted = await read(REVERTS).catch((e) => e);
  assert.equal(isContractRevert(reverted), true);
  assert.equal(toCliError(reverted).code, 'CONTRACT_ERROR');
  const limited = await read(LIMITED).catch((e) => e);
  assert.equal(isContractRevert(limited), false);
  assert.equal(isTransportFailure(limited), true);
  assert.equal(toCliError(limited).code, 'RPC_ERROR');
  const gasCap = await read(GAS_CAP).catch((e) => e);
  assert.equal(isContractRevert(gasCap), false);
  assert.equal(isGasCapError(gasCap), true);
  assert.equal(isGasCapError(limited), false);
  assert.deepEqual((({ code, retryable, exitCode }) => ({ code, retryable, exitCode }))(toCliError(gasCap)), { code: 'RPC_ERROR', retryable: false, exitCode: 4 });
  assert.match(toCliError(gasCap).hint, /higher gas cap/);
  const deep = [1, 2, 3, 4, 5].reduce((e) => new Error('wrapped', { cause: e }), limited);
  assert.equal(isContractRevert(deep), false);
  assert.equal(await orOnRevert(read(REVERTS), 'fallback'), 'fallback');
  assert.equal(isContractRevert(await read(SHORT).catch((e) => e)), false);
  const down = createPublicClient({ transport: http('http://127.0.0.1:1', { retryCount: 0 }) });
  await assert.rejects(orOnRevert(down.readContract({ address: REVERTS, abi, functionName: 'f' }), 'fallback'), { name: 'ContractFunctionExecutionError' });
});

test('isContractRevert classifies errors viem builds from real JSON-RPC answers, and the fakes mirror them', async (t) => {
  const A = '0x' + '0a'.repeat(20);
  const abi = parseAbi(['function reverts() view returns (address)', 'function internal() view returns (address)']);
  const rpc = await startRpc({ [`${A}.reverts`]: new Error('revert'), [`${A}.internal`]: RPC_INTERNAL }, { abi });
  t.after(rpc.close);
  const pc = createPublicClient({ transport: http(rpc.url, { retryCount: 0 }) });
  const fail = (address, functionName) => pc.readContract({ address, abi, functionName }).then(() => assert.fail('expected a rejection'), (e) => e);
  const names = (e) => {
    const out = [];
    for (let cur = e; cur instanceof Error; cur = cur.cause) out.push(cur.name);
    return out;
  };
  const isSubsequence = (sub, full) => sub.every(((i) => (n) => (i = full.indexOf(n, i) + 1) > 0)(0));
  for (const [real, fake, revert] of [
    [await fail(A, 'reverts'), revertError(), true],
    [await fail('0x' + '0b'.repeat(20), 'reverts'), zeroDataError(), true],
    [await fail(A, 'internal'), rpcInternalError(), false],
  ]) {
    assert.equal(isContractRevert(real), revert, names(real).join(' > '));
    assert.ok(isSubsequence(names(fake), names(real)), `${names(fake)} vs ${names(real)}`);
  }
});

test('upshift_evm encoders produce plan steps with correct targets and selectors', () => {
  const vault = '0x74aD2F789Ed583DBd141bbdafC673fE1F033718b';
  const dep = encodeDeposit(vault, '0x000000000000000000000000000000000000dEaD', 5n, OWNER);
  assert.equal(dep.kind, 'deposit');
  assert.equal(dep.to, vault);
  assert.equal(dep.value, '0');
  assert.match(dep.data, /^0x[0-9a-f]{8,}$/);

  const red = encodeRequestRedeem(vault, 7n, OWNER);
  assert.equal(red.kind, 'requestRedeem');
  assert.notEqual(red.data.slice(0, 10), dep.data.slice(0, 10), 'distinct selectors');

  const clm = encodeClaim(vault, { year: 2026, month: 9, day: 1 }, OWNER);
  assert.equal(clm.kind, 'claim');
  assert.equal(clm.to, vault);
});

test('sendSimulated: a wallet on another chain is rejected before simulating or sending', async () => {
  const { pc, wc, calls } = mockClients({ pcChain: 57073, wcChain: 1 });
  await assert.rejects(sendSimulated(pc, wc, depositCall), /wallet is on chain 1, expected 57073/);
  assert.equal(calls.simulate.length, 0);
  assert.equal(calls.write.length, 0);
});

test('sendSimulated: a wallet client without a chain is checked against its transport chain', async () => {
  const ok = mockClients({ pcChain: 57073, wcChain: null, walletTransportChain: 57073 });
  const sent = await sendSimulated(ok.pc, ok.wc, depositCall);
  assert.deepEqual(sent, { hash: TX, result: 7n, logs: [] });

  const off = mockClients({ pcChain: 57073, wcChain: null, walletTransportChain: 1 });
  await assert.rejects(sendSimulated(off.pc, off.wc, depositCall), /wallet is on chain 1, expected 57073/);
  assert.equal(off.calls.write.length, 0);
});

test('sendSimulated: a viem json-rpc wallet without a chain sends after the chain check', async () => {
  const { pc } = mockClients({ pcChain: 57073 });
  const methods = [];
  const wc = createWalletClient({
    account: OWNER,
    transport: custom({
      async request({ method }) {
        methods.push(method);
        if (method === 'eth_chainId') return '0xdef1';
        if (method === 'eth_sendTransaction') return TX;
        throw new Error(`unexpected ${method}`);
      },
    }),
  });
  const sent = await sendSimulated(pc, wc, depositCall);
  assert.equal(sent.hash, TX);
  assert.deepEqual(methods, ['eth_chainId', 'eth_sendTransaction']);
});

test('sendSimulated: a reverted receipt throws TransactionFailedError with the mined hash', async () => {
  const { pc, wc } = mockClients({ status: 'reverted' });
  await assert.rejects(sendSimulated(pc, wc, depositCall), (e) => {
    assert.ok(e instanceof TransactionFailedError);
    assert.equal(e.name, 'TransactionFailedError');
    assert.equal(e.reason, 'reverted');
    assert.equal(e.hash, TX);
    return true;
  });
});

test('sendSimulated: cancelled or replaced throws, repriced returns the replacement hash', async () => {
  for (const reason of ['cancelled', 'replaced']) {
    const { pc, wc } = mockClients({ replaced: reason });
    await assert.rejects(sendSimulated(pc, wc, depositCall), (e) => e instanceof TransactionFailedError && e.reason === reason && e.hash === TX);
  }
  const { pc, wc } = mockClients({ replaced: 'repriced' });
  const sent = await sendSimulated(pc, wc, depositCall);
  assert.equal(sent.hash, REPLACEMENT_TX);
});

test('boring deposit: v2 tellers get the 4-arg referral deposit, v1 the 3-arg one', async () => {
  const cfg = { vault: VAULT, teller: VAULT, accountant: VAULT, queue: QUEUE, rolesAuthority: VAULT, chainId: 1 };
  const v1 = mockClients();
  await boringDeposit(v1.pc, v1.wc, cfg, ASSET, 10n, 9n);
  assert.equal(v1.calls.write[0].abi, tellerAbi);
  assert.deepEqual(v1.calls.write[0].args, [ASSET, 10n, 9n]);

  const v2 = mockClients();
  const out = await boringDeposit(v2.pc, v2.wc, cfg, ASSET, 10n, 9n, 'v2');
  assert.equal(v2.calls.simulate[0].abi, tellerDepositV2Abi);
  assert.deepEqual(v2.calls.write[0].args, [ASSET, 10n, 9n, '0x0000000000000000000000000000000000000000']);
  assert.equal(out.shares, 7n);
});

test('boring requestWithdraw: the requestId comes from the queue event, not the simulation', async () => {
  const cfg = { vault: VAULT, teller: VAULT, accountant: VAULT, queue: QUEUE, rolesAuthority: VAULT, chainId: 1 };
  const minedId = `0x${'cd'.repeat(32)}`;
  const log = (address, requestId) => ({
    address,
    topics: encodeEventTopics({ abi: boringQueueAbi, eventName: 'OnChainWithdrawRequested', args: { requestId, user: OWNER, assetOut: ASSET } }),
    data: encodeAbiParameters(parseAbiParameters('uint96, uint128, uint128, uint40, uint24, uint24'), [3n, 10n, 9n, 1_700_000_000, 0, 3600]),
    blockHash: null, blockNumber: null, logIndex: 0, transactionHash: TX, transactionIndex: 0, removed: false,
  });
  const { pc, wc } = mockClients({
    result: `0x${'ee'.repeat(32)}`,
    logs: [log(VAULT, `0x${'ff'.repeat(32)}`), log(QUEUE, minedId)],
  });
  const out = await requestWithdraw(pc, wc, cfg, ASSET, 10n, 5, 3600);
  assert.equal(out.requestId, minedId);
  assert.equal(out.request.nonce, 3n);
  assert.equal(out.request.creationTime, 1_700_000_000);

  const noEvent = mockClients({ result: `0x${'ee'.repeat(32)}`, logs: [log(VAULT, minedId)] });
  await assert.rejects(requestWithdraw(noEvent.pc, noEvent.wc, cfg, ASSET, 10n, 5, 3600), new RegExp(`${TX}.*without an OnChainWithdrawRequested event`));
});

const TOKEN = '0x' + 'aa'.repeat(20);
const DEP_VAULT = '0x' + 'cc'.repeat(20);
const LP = '0x' + 'dd'.repeat(20);
const BORING_CFG = {
  vault: DEP_VAULT, teller: '0x' + '33'.repeat(20), accountant: '0x' + '44'.repeat(20),
  queue: '0x' + '55'.repeat(20), rolesAuthority: '0x' + '22'.repeat(20), chainId: 1,
};

const reverted = () => new BaseError('call failed', { cause: new ExecutionRevertedError() });
const approveData = (spender, amount) => encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] });

function depositPc({ allowance, call }) {
  const calls = [];
  return {
    calls,
    getChainId: async () => 1,
    call: async (req) => { calls.push(req); return call(req); },
    readContract: async ({ address, functionName, args }) => {
      const onToken = address.toLowerCase() === TOKEN;
      switch (functionName) {
        case 'allowance': return onToken ? allowance : 0n;
        case 'balanceOf': return onToken ? 100n : 0n;
        case 'symbol': return 'X';
        case 'decimals': return 6;
        case 'asset': return TOKEN;
        case 'lpTokenAddress': return LP;
        case 'previewDeposit': return args.length === 2 ? [10n, 10n] : 10n;
        case 'maxDeposit': case 'depositCap': case 'maxDepositAmount': case 'maxWithdrawalAmount': return 10n ** 18n;
        case 'getRateInQuoteSafe': return 10n ** 6n;
        case 'getSharePrice': return 1n;
        case 'assetData': return [true, true, 0];
        case 'canCall': return true;
        case 'isPaused': case 'depositsPaused': case 'withdrawalsPaused': return false;
        case 'sendersWhitelistAddress': case 'assetsWhitelistAddress': return zeroAddress;
        case 'receiveSharesGate': throw revertError('receiveSharesGate');
        default: return 0n;
      }
    },
  };
}

const FAMILIES = [
  { family: 'morpho', plan: (pc, amount) => morphoPlanDeposit(pc, DEP_VAULT, { assets: amount, owner: OWNER }) },
  { family: 'upshift_evm', plan: (pc, amount) => upshiftPlanDeposit(pc, DEP_VAULT, { amount, owner: OWNER }) },
  { family: 'boring', plan: (pc, amount) => boringPlanDeposit(pc, BORING_CFG, { asset: TOKEN, amount, owner: OWNER }) },
];

for (const { family, plan } of FAMILIES) {
  test(`${family} planDeposit: zero allowance approves without simulating`, async () => {
    const pc = depositPc({ allowance: 0n, call: () => assert.fail('must not simulate') });
    const p = await plan(pc, 10n);
    assert.deepEqual(p.blockers, []);
    assert.deepEqual(p.steps.map((s) => s.kind), ['approve', 'deposit']);
    assert.equal(pc.calls.length, 0);
  });

  test(`${family} planDeposit: sufficient allowance skips the approve`, async () => {
    const pc = depositPc({ allowance: 10n, call: () => assert.fail('must not simulate') });
    const p = await plan(pc, 10n);
    assert.deepEqual(p.steps.map((s) => s.kind), ['deposit']);
    assert.equal(pc.calls.length, 0);
  });

  test(`${family} planDeposit: residual allowance the token lets overwrite ⇒ approve only`, async () => {
    const pc = depositPc({ allowance: 5n, call: () => ({ data: '0x' + '0'.repeat(63) + '1' }) });
    const p = await plan(pc, 10n);
    assert.deepEqual(p.steps.map((s) => s.kind), ['approve', 'deposit']);
    assert.equal(pc.calls.length, 1);
    assert.equal(pc.calls[0].account, OWNER);
    assert.equal(pc.calls[0].to, TOKEN);
    assert.equal(pc.calls[0].data, approveData(DEP_VAULT, 10n));
    assert.equal(p.steps[0].data, pc.calls[0].data, 'the simulated call is the approve step');
  });

  test(`${family} planDeposit: residual allowance the token refuses to overwrite ⇒ reset + approve`, async () => {
    const pc = depositPc({ allowance: 5n, call: () => { throw reverted(); } });
    const p = await plan(pc, 10n);
    assert.deepEqual(p.steps.map((s) => s.kind), ['approveReset', 'approve', 'deposit']);
    assert.equal(p.steps[0].to, TOKEN);
    assert.equal(p.steps[0].data, approveData(DEP_VAULT, 0n));
  });

  test(`${family} planDeposit: a transport failure during the simulation propagates`, async () => {
    const pc = depositPc({ allowance: 5n, call: () => { throw new HttpRequestError({ url: 'http://127.0.0.1:1', status: 503 }); } });
    await assert.rejects(plan(pc, 10n), (e) => e.name === 'HttpRequestError');
  });
}

test('upshift_evm planDeposit simulates the approve on assetIn, not the reference asset', async () => {
  const OTHER = '0x' + 'ee'.repeat(20);
  const pc = depositPc({ allowance: 0n, call: () => ({ data: undefined }) });
  const read = pc.readContract;
  pc.readContract = async (req) => {
    if (req.functionName === 'isWhitelisted') return true;
    if (req.address.toLowerCase() === OTHER) {
      if (req.functionName === 'allowance') return 5n;
      if (req.functionName === 'balanceOf') return 100n;
    }
    return read(req);
  };
  const p = await upshiftPlanDeposit(pc, DEP_VAULT, { amount: 10n, owner: OWNER, assetIn: OTHER });
  assert.deepEqual(p.steps.map((s) => s.kind), ['approve', 'deposit']);
  assert.equal(pc.calls.length, 1);
  assert.equal(pc.calls[0].to, OTHER);
});

const needsReset = (call) => approveNeedsReset({ call }, OWNER, { to: TOKEN, data: approveData(DEP_VAULT, 10n) });

test('approveNeedsReset: an approve with no return data (USDT style) needs no reset', async () => {
  assert.equal(await needsReset(async () => ({ data: undefined })), false);
});

test('approveNeedsReset: an approve that returns false needs the reset', async () => {
  assert.equal(await needsReset(async () => ({ data: '0x' + '0'.repeat(64) })), true);
});

test('approveNeedsReset: an empty 0x return is success, not a decode crash', async () => {
  assert.equal(await needsReset(async () => ({ data: '0x' })), false);
});

test('approveNeedsReset: a null or non-hex result from a nonconforming node keeps the reset', async () => {
  assert.equal(await needsReset(async () => ({ data: null })), true);
  assert.equal(await needsReset(async () => ({ data: 'nothex' })), true);
});

test('approveNeedsReset: only the first return word is the bool', async () => {
  assert.equal(await needsReset(async () => ({ data: '0x' + '0'.repeat(64) + 'f'.repeat(64) })), true);
});

test('approveNeedsReset: programming errors are rethrown, not read as a reset', async () => {
  await assert.rejects(approveNeedsReset({}, OWNER, { to: TOKEN, data: approveData(DEP_VAULT, 10n) }), TypeError);
});

test('approveNeedsReset: any execution failure keeps the reset, whatever the node or viem copy', async () => {
  const foreignRevert = { name: 'CallExecutionError', cause: { name: 'ExecutionRevertedError' } };
  const nethermind = { name: 'CallExecutionError', cause: { name: 'RpcRequestError', code: -32015, details: 'VM execution error.' } };
  const invalidOpcode = { name: 'CallExecutionError', cause: { name: 'InvalidInputRpcError', cause: { name: 'RpcRequestError', code: -32000, details: 'invalid opcode: INVALID' } } };
  const revertOverHttp400 = { name: 'CallExecutionError', cause: { name: 'ExecutionRevertedError', cause: { name: 'HttpRequestError', status: 400 } } };
  const revertUnderTransport = { name: 'CallExecutionError', cause: { name: 'HttpRequestError', cause: { name: 'ExecutionRevertedError' } } };
  const code3UnderTimeout = { name: 'CallExecutionError', cause: { name: 'TimeoutError', cause: { code: 3 } } };
  const eip1193NonstandardRevert = { name: 'CallExecutionError', cause: { name: 'UnknownRpcError', code: -1, cause: { code: -32099, message: 'VM Exception while processing transaction: revert' } } };
  const eip1193NethermindRevert = { name: 'CallExecutionError', cause: { name: 'UnknownRpcError', code: -1, cause: { code: -32015, message: 'VM execution error.' } } };
  const eip1193RevertData = { name: 'CallExecutionError', cause: { name: 'UnknownRpcError', code: -1, cause: { code: -32099, message: 'call failed', data: '0x08c379a0' } } };
  for (const err of [reverted(), foreignRevert, nethermind, invalidOpcode, revertOverHttp400, revertUnderTransport, code3UnderTimeout, eip1193NonstandardRevert, eip1193NethermindRevert, eip1193RevertData]) {
    assert.equal(await needsReset(async () => { throw err; }), true, err.name);
  }
});

test('approveNeedsReset: transport failures are rethrown, not read as a reset', async () => {
  const limit = { name: 'CallExecutionError', cause: { name: 'RpcRequestError', code: -32005, details: 'rate limited' } };
  const timeout = { name: 'CallExecutionError', cause: { name: 'TimeoutError' } };
  const rpc429 = { name: 'CallExecutionError', cause: { name: 'RpcRequestError', code: 429 } };
  const eip1193FetchFailure = { name: 'CallExecutionError', cause: { name: 'UnknownRpcError', code: -1, cause: new TypeError('Failed to fetch') } };
  const eip1193SocketReset = { name: 'CallExecutionError', cause: { name: 'UnknownRpcError', code: -1, cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) } };
  const eip1193Timeout = { name: 'CallExecutionError', cause: { name: 'UnknownRpcError', code: -1, cause: new Error('Request timed out') } };
  const disconnected = { name: 'CallExecutionError', cause: { name: 'ProviderDisconnectedError', code: 4900 } };
  const chainDisconnected = { name: 'CallExecutionError', cause: { name: 'ChainDisconnectedError', code: 4901 } };
  const pending = { name: 'CallExecutionError', cause: { name: 'ResourceUnavailableRpcError', code: -32002 } };
  const eip1193Gateway = { name: 'CallExecutionError', cause: { name: 'UnknownRpcError', code: -1, cause: { code: 503, message: 'Service Unavailable' } } };
  const eip1193DomNetwork = { name: 'CallExecutionError', cause: { name: 'UnknownRpcError', code: -1, cause: new DOMException('offline', 'NetworkError') } };
  const aborted = new DOMException('aborted', 'AbortError');
  const eip1193ProxydRateLimit = { name: 'CallExecutionError', cause: { name: 'UnknownRpcError', code: -1, cause: { code: -32016, message: 'over rate limit' } } };
  const eip1193ProxydGatewayTimeout = { name: 'CallExecutionError', cause: { name: 'UnknownRpcError', code: -1, cause: { code: -32015, message: 'gateway timeout' } } };
  for (const err of [eip1193ProxydRateLimit, eip1193ProxydGatewayTimeout, new HttpRequestError({ url: 'http://127.0.0.1:1', status: 429 }), limit, timeout, rpc429, eip1193FetchFailure, eip1193SocketReset, eip1193Timeout, disconnected, chainDisconnected, pending, eip1193Gateway, eip1193DomNetwork, aborted]) {
    await assert.rejects(needsReset(async () => { throw err; }), (e) => e === err);
  }
});
