import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  ContractFunctionExecutionError, ContractFunctionRevertedError, ContractFunctionZeroDataError,
  ExecutionRevertedError, InternalRpcError, RpcRequestError,
  decodeFunctionData, encodeFunctionResult, multicall3Abi, toFunctionSelector,
} from 'viem';

export function fakePc(reads, { chainId = 1, blockTimestamp = 2_000n, ...extra } = {}) {
  const calls = [];
  return {
    calls,
    getChainId: async () => chainId,
    getBlock: async () => ({ timestamp: blockTimestamp }),
    readContract: async ({ address, functionName, args }) => {
      calls.push({ address: address.toLowerCase(), functionName, args });
      const key = `${address.toLowerCase()}.${functionName}`;
      const h = key in reads ? reads[key] : undefined;
      if (h === undefined) throw new Error(`unexpected read ${key}`);
      const v = typeof h === 'function' ? h(args) : h;
      if (v instanceof Error) throw v;
      return v;
    },
    ...extra,
  };
}

// mirrors the cause chains viem's readContract builds; sdk.test.mjs checks them against startRpc
const readError = (cause, functionName) => new ContractFunctionExecutionError(cause, { abi: [], functionName });

export const revertError = (functionName = 'f') => readError(new ContractFunctionRevertedError({
  abi: [], functionName, message: 'execution reverted', cause: new ExecutionRevertedError({ message: 'execution reverted' }),
}), functionName);

export const zeroDataError = (functionName = 'f') => readError(new ContractFunctionZeroDataError({ functionName }), functionName);

export const rpcInternalError = (functionName = 'f') => readError(new ContractFunctionRevertedError({
  abi: [], functionName, message: 'Internal error', cause: new InternalRpcError(new RpcRequestError({ body: {}, error: { code: -32603, message: 'Internal error' }, url: 'http://fake' })),
}), functionName);

export const RPC_INTERNAL = 'rpc:-32603';

const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const REVERT = Symbol('revert');
const NO_CODE = Symbol('no-code');
const notStubbed = (what) => ({ error: { code: -32601, message: `not stubbed: ${what}` } });
const ERRORS = {
  [RPC_INTERNAL]: { error: { code: -32603, message: 'Internal error' } },
  [REVERT]: { error: { code: 3, message: 'execution reverted', data: '0x' } },
  [NO_CODE]: notStubbed('eth_call to an address without code'),
};

// Unlisted function on a listed/deployed address: revert, or 0x with missingFunction 'empty'.
// Unlisted address: no code (0x), or -32601 with missingAddress 'error'.
export function rpcHandler(reads, {
  abi = [], chainId = 1, blockTimestamp = 2_000n, logs = [], deployed = [],
  missingFunction = 'revert', missingAddress = 'empty',
} = {}) {
  const bySelector = new Map();
  for (const item of abi.filter((i) => i.type === 'function')) {
    const sel = toFunctionSelector(item);
    bySelector.set(sel, [...(bySelector.get(sel) ?? []), item]);
  }
  const known = new Set([...deployed, ...Object.keys(reads).map((k) => k.split('.')[0])].map((a) => a.toLowerCase()));
  const answer = (to, data) => {
    const addr = to.toLowerCase();
    const item = (bySelector.get(data.slice(0, 10)) ?? []).find((i) => Object.hasOwn(reads, `${addr}.${i.name}`));
    if (!item) {
      if (!known.has(addr)) return missingAddress === 'error' ? NO_CODE : '0x';
      return missingFunction === 'empty' ? '0x' : REVERT;
    }
    const { args = [] } = decodeFunctionData({ abi: [item], data });
    const h = reads[`${addr}.${item.name}`];
    const v = typeof h === 'function' ? h(args) : h;
    if (v === RPC_INTERNAL) return RPC_INTERNAL;
    if (v instanceof Error) return REVERT;
    return encodeFunctionResult({ abi: [item], functionName: item.name, result: v });
  };
  return (c) => {
    if (c.method === 'eth_chainId') return { result: '0x' + Number(chainId).toString(16) };
    if (c.method === 'eth_getLogs') return logs instanceof Error ? { error: { code: -32005, message: logs.message } } : { result: logs };
    if (c.method === 'eth_getBlockByNumber') {
      return {
        result: {
          number: '0x10', hash: '0x' + '12'.repeat(32), parentHash: '0x' + '00'.repeat(32), timestamp: '0x' + blockTimestamp.toString(16),
          transactions: [], gasLimit: '0x0', gasUsed: '0x0', baseFeePerGas: null, logsBloom: null, nonce: null, size: '0x0',
        },
      };
    }
    if (c.method !== 'eth_call') return notStubbed(c.method);
    const { to, data, input } = c.params[0];
    const calldata = data ?? input;
    if (to.toLowerCase() === MULTICALL3) {
      const { args: [calls] } = decodeFunctionData({ abi: multicall3Abi, data: calldata });
      const results = calls.map((call) => answer(call.target, call.callData));
      const fatal = results.find((r) => r === RPC_INTERNAL || r === NO_CODE);
      if (fatal) return ERRORS[fatal];
      return {
        result: encodeFunctionResult({
          abi: multicall3Abi, functionName: 'aggregate3',
          result: results.map((r) => (r === REVERT ? { success: false, returnData: '0x' } : { success: true, returnData: r })),
        }),
      };
    }
    const r = answer(to, calldata);
    return typeof r === 'string' && r !== RPC_INTERNAL ? { result: r } : ERRORS[r];
  };
}

export function jsonRpcListener(handle, fallback = (_req, res) => { res.writeHead(404).end(); }) {
  return (req, res) => {
    if (req.method !== 'POST') return fallback(req, res);
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(raw);
      const out = [].concat(parsed).map((c) => ({ jsonrpc: '2.0', id: c.id, ...handle(c) }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(parsed) ? out : out[0]));
    });
  };
}

export async function startRpc(reads, opts) {
  const requests = [];
  const handle = rpcHandler(reads, opts);
  const server = createServer(jsonRpcListener((c) => { requests.push(c); return handle(c); }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() };
}
