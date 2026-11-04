/**
 * Plan envelope — the common serialization format every vault family's
 * plan* builders return. This is a payload convention, NOT a unified vault
 * interface: step counts, kinds, and context stay family-specific.
 *
 * All amounts are decimal strings so a plan is JSON-safe end to end
 * (agents pipe these straight into signers).
 *
 * Also exports the client types the families take and `sendSimulated`, the
 * write helper their `core` execute wrappers share.
 */
import {
  hexToBigInt, isHex, slice,
  type Abi, type Account, type Address, type ContractFunctionArgs, type ContractFunctionName, type ContractFunctionReturnType,
  type Hex, type Log, type PublicClient, type WalletClient,
} from 'viem';

/**
 * What family reads and plan builders call. Narrower than viem's `PublicClient`
 * because its chain-typed methods reject clients for OP-stack and zkSync chains.
 */
export type ReadClient = Pick<PublicClient, 'getChainId' | 'getLogs' | 'readContract'> & {
  getBlock(): Promise<{ timestamp: bigint }>;
  call(args: { account: Address; to: Address; data: Hex }): Promise<{ data?: Hex }>;
};

export interface ContractCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

/** {@link ReadClient} plus the receipt and simulation methods the `core` execute wrappers call. */
export type WriteClient = ReadClient & {
  simulateContract(args: ContractCall & { account: Account }): Promise<{ result: unknown }>;
  waitForTransactionReceipt(args: {
    hash: Hex;
    onReplaced?: (replacement: { reason: 'cancelled' | 'replaced' | 'repriced' }) => void;
  }): Promise<{ status: 'success' | 'reverted'; transactionHash: Hex; logs: Log[] }>;
};

/** The wallet methods the `core` execute wrappers call; a `WalletClient` for any chain fits. */
export type SignerClient = Pick<WalletClient, 'account' | 'chain' | 'getChainId' | 'writeContract'>;

type WriteMutability = 'nonpayable' | 'payable';

/** Thrown by {@link sendSimulated} when the mined transaction reverted, or the wallet cancelled or replaced it before it was mined. */
export class TransactionFailedError extends Error {
  readonly reason: 'reverted' | 'cancelled' | 'replaced';
  readonly hash: Hex;

  constructor(reason: 'reverted' | 'cancelled' | 'replaced', hash: Hex) {
    super(`@sentora/vaults-plan: transaction ${hash} ${reason === 'reverted' ? 'reverted' : `was ${reason} by the wallet`}`);
    this.name = 'TransactionFailedError';
    this.reason = reason;
    this.hash = hash;
  }
}

/**
 * Simulates a contract write, sends it from the wallet's account, and waits for
 * the receipt.
 *
 * @param pc Client used to simulate and await the receipt.
 * @param wc Wallet client that signs and sends the transaction; must carry an account.
 * @param call Contract, ABI, function and arguments to call.
 * @returns The mined transaction hash (the replacement's when the wallet sped it up), the simulated return value, and the receipt logs.
 * @throws When the wallet has no account or is on a different chain than `pc`, or the simulation reverts.
 * @throws {TransactionFailedError} When the wallet cancels or replaces the transaction with a different one, or the mined receipt has status `reverted`.
 */
export async function sendSimulated<
  const abi extends Abi,
  functionName extends ContractFunctionName<abi, WriteMutability>,
>(
  pc: WriteClient, wc: SignerClient,
  call: ContractCall & { abi: abi; functionName: functionName; args: ContractFunctionArgs<abi, WriteMutability, functionName> },
): Promise<{ hash: Hex; result: ContractFunctionReturnType<abi, WriteMutability, functionName>; logs: Log[] }> {
  const account = wc.account;
  if (account === undefined) throw new Error('@sentora/vaults-plan: wallet client has no account');
  const [chainId, walletChainId] = await Promise.all([pc.getChainId(), wc.chain?.id ?? wc.getChainId()]);
  if (walletChainId !== chainId) {
    throw new Error(`@sentora/vaults-plan: wallet is on chain ${walletChainId}, expected ${chainId}`);
  }
  const plain: ContractCall = call;
  const { result } = await pc.simulateContract({ ...plain, account });
  const hash = await wc.writeContract({ ...plain, account, chain: wc.chain ?? null });
  let replaced: 'cancelled' | 'replaced' | undefined;
  const receipt = await pc.waitForTransactionReceipt({
    hash,
    onReplaced: ({ reason }) => { if (reason !== 'repriced') replaced = reason; },
  });
  if (replaced !== undefined) throw new TransactionFailedError(replaced, hash);
  if (receipt.status === 'reverted') throw new TransactionFailedError('reverted', receipt.transactionHash);
  return {
    hash: receipt.transactionHash,
    result: result as ContractFunctionReturnType<abi, WriteMutability, functionName>,
    logs: receipt.logs,
  };
}

export interface TxStep {
  /** family-specific step kind, e.g. 'approve' | 'deposit' | 'requestWithdraw' */
  kind: string;
  description: string;
  to: Address;
  data: Hex;
  /** wei, decimal string */
  value: string;
}

export interface PlanBlocker {
  code: string;
  message: string;
  /** base units, decimal string: what the owner has or offers, or the headroom under a limit */
  available?: string;
  /** base units, decimal string: what the action needs (for a minimum, the minimum) */
  required?: string;
  /** token decimals of `available` / `required`, set only when known */
  decimals?: number;
}

export interface Plan {
  family: string;
  action: string;
  chainId?: number;
  vault: Address;
  /** ordered; sign & send sequentially, waiting for each receipt */
  steps: TxStep[];
  /** previewed outcomes, decimal strings keyed by name (e.g. shares, assets) */
  expected: Record<string, string>;
  /** non-empty ⇒ do NOT execute; steps may be partial or empty */
  blockers: PlanBlocker[];
  warnings: string[];
  /** family-specific extras a caller may need to persist or display */
  context: Record<string, unknown>;
}

/** Zero-wei step value, in the decimal-string convention used by {@link TxStep.value}. */
export const zeroValue = '0';

/**
 * Builds a blocked plan: a {@link Plan} whose `steps` default to an empty
 * array. Use when preflight found blockers before (or instead of) producing
 * executable steps.
 *
 * @param plan Plan fields without `steps` (or with partial `steps` to keep any
 *   steps already built before the blocker was hit).
 * @returns The completed plan with `steps` defaulted to `[]` when omitted.
 */
export function blocked(plan: Omit<Plan, 'steps'> & Partial<Pick<Plan, 'steps'>>): Plan {
  return { steps: [], ...plan };
}

/**
 * True only when a viem read failed because the contract reverted or returned
 * no data, i.e. the call reached the EVM. Use it to gate fallbacks that treat
 * a missing getter as "feature absent"; anything else (transport, timeout,
 * node error) should propagate.
 *
 * viem wraps a JSON-RPC -32603 Internal error in ContractFunctionRevertedError
 * too, so a chain containing InternalRpcError is not a revert. Matching on
 * `name` rather than `instanceof` keeps this correct when the caller's viem is
 * a different copy than ours.
 * Needs viem >= 2.47.5: older versions drop the cause chain, so a -32603 reads as a revert.
 *
 * @param error Anything caught from a viem call.
 * @returns Whether the failure is a genuine revert or zero-data response.
 */
export function isContractRevert(error: unknown): boolean {
  const chain = causeChain(error);
  const names = new Set(chain.filter((e) => e instanceof Error).map((e) => e.name));
  // nodes report an empty revert as -32000 "execution reverted" with no data, which viem surfaces only as ExecutionRevertedError
  return (names.has('ContractFunctionRevertedError') || names.has('ContractFunctionZeroDataError') || names.has('ExecutionRevertedError'))
    && !names.has('InternalRpcError')
    && !chain.some((e) => isTransientCode(e) || hasGasCapMessage(e));
}

/** Resolves to `fallback` when the call reverts; RPC and transport failures still reject. */
export function orOnRevert<T, F>(promise: Promise<T>, fallback: F): Promise<T | F> {
  return promise.catch((e: unknown) => (isContractRevert(e) ? fallback : Promise.reject(e)));
}

const TRANSPORT_ERRORS = new Set(['HttpRequestError', 'TimeoutError', 'SocketClosedError', 'WebSocketRequestError', 'TypeError', 'AbortError']);
const TRANSIENT_RPC_CODES = new Set([-32005, -32002, 429, 4900, 4901]);
const REVERT_MESSAGE = /revert|vm execution error/i;
// viem files the node's eth_call gas cap under ExecutionRevertedError too, but it is a node limit, not the contract
const GAS_CAP_MESSAGE = /gas required exceeds allowance/i;

const isTransientCode = (e: ErrorLink): boolean => typeof e.code === 'number' && TRANSIENT_RPC_CODES.has(e.code);
const hasGasCapMessage = (e: ErrorLink): boolean => typeof e.message === 'string' && GAS_CAP_MESSAGE.test(e.message);

interface ErrorLink { name?: unknown; code?: unknown; message?: unknown; data?: unknown; cause?: unknown }

const looksLikeRevert = (e: ErrorLink): boolean =>
  e.code === 3 || (typeof e.data === 'string' && e.data.startsWith('0x')) || (typeof e.message === 'string' && REVERT_MESSAGE.test(e.message));

function causeChain(err: unknown): ErrorLink[] {
  const chain: ErrorLink[] = [];
  const seen = new Set<unknown>();
  for (let cur = err; typeof cur === 'object' && cur !== null && !seen.has(cur); cur = (cur as ErrorLink).cause) {
    seen.add(cur);
    chain.push(cur as ErrorLink);
  }
  return chain;
}

/** Whether a viem error is a network or transient node failure (timeouts, rate limits, unavailable node) worth retrying, as opposed to anything the call itself caused. */
// by name/code rather than instanceof: the caller's client may come from another viem copy
export function isTransportFailure(err: unknown): boolean {
  const chain = causeChain(err);
  if (chain.some(isTransientCode)) return true;
  if (chain.some((e) => e.name === 'ExecutionRevertedError' || e.code === 3)) return false;
  // viem's catch-all -1 wraps both network failures and reverts sent with nonstandard codes
  const revertUnderUnknown = chain.some((e) => e.code !== -1 && looksLikeRevert(e));
  return chain.some((e) =>
    (typeof e.name === 'string' && TRANSPORT_ERRORS.has(e.name))
    || (e.code === -1 && !revertUnderUnknown));
}

/** Whether a viem error is the node's eth_call gas cap: a limit of that RPC, so retrying the same endpoint does not help. */
export function isGasCapError(err: unknown): boolean {
  return causeChain(err).some(hasGasCapMessage);
}

/** Whether a viem error comes from decoding the call's return data, i.e. the target answered with data of another shape. */
export function isAbiDecodingError(err: unknown): boolean {
  return causeChain(err).some((e) => typeof e.name === 'string' && e.name.startsWith('AbiDecoding'));
}

/** USDT-style tokens reject a nonzero-to-nonzero approve. Transport failures are rethrown so plans stay deterministic. */
export async function approveNeedsReset(
  pc: Pick<ReadClient, 'call'>, owner: Address, approve: Pick<TxStep, 'to' | 'data'>,
): Promise<boolean> {
  let result: Hex | undefined;
  try {
    ({ data: result } = await pc.call({ account: owner, to: approve.to, data: approve.data }));
  } catch (err) {
    if (isTransportFailure(err)) throw err;
    return true;
  }
  // no return data is success (USDT's approve returns nothing); an explicit false is a rejection
  if (result === undefined || result === '0x') return false;
  if (!isHex(result)) return true;
  return hexToBigInt(slice(result, 0, 32)) === 0n;
}
