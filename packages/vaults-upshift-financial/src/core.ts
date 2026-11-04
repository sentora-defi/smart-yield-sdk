/**
 * Framework-free Upshift Financial primitives. Takes viem clients.
 *
 * KEY DIFFERENCES from the ERC-4626 families:
 *  - the vault is NOT the share token: shares live on `lpTokenAddress` (an
 *    OFT/ERC-20 the vault mints and burns)
 *  - deposits are multi-asset: any whitelisted `assetIn` (or the reference
 *    asset) is accepted; caps are enforced in reference-asset units
 *  - QUEUED redemption (requestRedeem) transferFroms LP shares → the vault, so
 *    it needs share allowance; INSTANT redemption burns directly (no allowance)
 *  - requestRedeem returns the claim date as explicit (year, month, day) plus
 *    a claimableEpoch unix timestamp — claim(year, month, day, receiver) later
 *  - sender/asset whitelists can gate every user-facing call
 */
import type { Address, Hex } from 'viem';
import { orOnRevert, sendSimulated, type ReadClient, type SignerClient, type WriteClient } from '@sentora/vaults-plan';
import { zeroAddress } from 'viem';
import { tokenizedVaultAbi, whitelistAbi, erc20Abi } from './abi.js';

export interface ClaimDate {
  year: number;
  month: number;
  day: number;
}

export interface VaultMeta {
  vault: Address;
  lpToken: Address;
  shareSymbol: string;
  shareDecimals: number;
  asset: Address;
  assetSymbol: string;
  assetDecimals: number;
  totalAssets: bigint;
  totalSupply: bigint;
  sharePrice: bigint;
  depositsPaused: boolean;
  withdrawalsPaused: boolean;
  depositCap: bigint;
  maxDepositAmount: bigint;
  maxWithdrawalAmount: bigint;
  instantRedemptionFee: bigint;
  withdrawalFee: bigint;
  /** 0 ⇒ no timelock: requestRedeem reverts, use instantRedeem */
  lagDuration: bigint;
}

/**
 * Reads the vault's metadata, limits, and current state in one pass: token identities,
 * totals, share price, pause flags, caps, fees, and the timelock.
 *
 * @param pc - `ReadClient` used for the reads.
 * @param vault - Vault address (not the share token — shares live on lpToken).
 * @returns A `VaultMeta` with vault, lpToken, share/asset symbols and decimals, totalAssets, totalSupply, sharePrice, depositsPaused, withdrawalsPaused, depositCap, maxDepositAmount, maxWithdrawalAmount, instantRedemptionFee, withdrawalFee, and lagDuration (0 ⇒ no timelock: requestRedeem reverts, use instantRedeem).
 */
export async function getVaultMeta(pc: ReadClient, vault: Address): Promise<VaultMeta> {
  const v = { address: vault, abi: tokenizedVaultAbi } as const;
  const [asset, lpToken, totalAssets, sharePrice, depositsPaused, withdrawalsPaused] = await Promise.all([
    pc.readContract({ ...v, functionName: 'asset' }),
    pc.readContract({ ...v, functionName: 'lpTokenAddress' }),
    pc.readContract({ ...v, functionName: 'getTotalAssets' }),
    pc.readContract({ ...v, functionName: 'getSharePrice' }),
    pc.readContract({ ...v, functionName: 'depositsPaused' }),
    pc.readContract({ ...v, functionName: 'withdrawalsPaused' }),
  ]);
  const [depositCap, maxDepositAmount, maxWithdrawalAmount, instantRedemptionFee, withdrawalFee, lagDuration] = await Promise.all([
    pc.readContract({ ...v, functionName: 'depositCap' }),
    pc.readContract({ ...v, functionName: 'maxDepositAmount' }),
    pc.readContract({ ...v, functionName: 'maxWithdrawalAmount' }),
    pc.readContract({ ...v, functionName: 'instantRedemptionFee' }),
    pc.readContract({ ...v, functionName: 'withdrawalFee' }),
    pc.readContract({ ...v, functionName: 'lagDuration' }),
  ]);
  const [shareSymbol, shareDecimals, totalSupply, assetSymbol, assetDecimals] = await Promise.all([
    pc.readContract({ address: lpToken, abi: erc20Abi, functionName: 'symbol' }),
    pc.readContract({ address: lpToken, abi: erc20Abi, functionName: 'decimals' }),
    pc.readContract({ address: lpToken, abi: erc20Abi, functionName: 'totalSupply' }),
    pc.readContract({ address: asset, abi: erc20Abi, functionName: 'symbol' }),
    pc.readContract({ address: asset, abi: erc20Abi, functionName: 'decimals' }),
  ]);
  return {
    vault, lpToken, shareSymbol, shareDecimals, asset, assetSymbol, assetDecimals,
    totalAssets, totalSupply, sharePrice, depositsPaused, withdrawalsPaused,
    depositCap, maxDepositAmount, maxWithdrawalAmount, instantRedemptionFee, withdrawalFee, lagDuration,
  };
}

export interface Position {
  shares: bigint;
  /** value of the shares in the reference asset, before withdrawal fees */
  assets: bigint;
  assetBalance: bigint;
  /** deposit-asset allowance → vault (deposit path) */
  allowance: bigint;
  /** LP share allowance → vault (QUEUED redeem path; instant needs none) */
  shareAllowance: bigint;
}

/**
 * Reads a user's position: LP share balance, its pre-fee value in the
 * reference asset, deposit-asset balance, and both path-specific allowances.
 *
 * @param pc - `ReadClient` used for the reads.
 * @param vault - Vault address.
 * @param asset - Deposit asset for the balance and allowance reads.
 * @param user - Address whose position is read.
 * @returns A `Position` with shares, assets (share value in the reference asset, before withdrawal fees), assetBalance, allowance (deposit asset → vault), and shareAllowance (LP shares → vault, queued redeem path only; instant needs none).
 */
export async function getPosition(pc: ReadClient, vault: Address, asset: Address, user: Address): Promise<Position> {
  const lpToken = await pc.readContract({ address: vault, abi: tokenizedVaultAbi, functionName: 'lpTokenAddress' });
  const [shares, assetBalance, allowance, shareAllowance] = await Promise.all([
    pc.readContract({ address: lpToken, abi: erc20Abi, functionName: 'balanceOf', args: [user] }),
    pc.readContract({ address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [user] }),
    pc.readContract({ address: asset, abi: erc20Abi, functionName: 'allowance', args: [user, vault] }),
    pc.readContract({ address: lpToken, abi: erc20Abi, functionName: 'allowance', args: [user, vault] }),
  ]);
  const assets = shares > 0n
    ? (await pc.readContract({ address: vault, abi: tokenizedVaultAbi, functionName: 'previewRedemption', args: [shares, false] }))[0]
    : 0n;
  return { shares, assets, assetBalance, allowance, shareAllowance };
}

export interface GateCheck {
  /** senders whitelist configured */
  sendersGated: boolean;
  /** user may call deposit/redeem/claim (true when ungated) */
  canSend: boolean;
  /** assetIn accepted by the deposit path */
  assetAllowed: boolean;
}

/**
 * Checks the vault's sender and asset whitelist gates for a user and an
 * optional deposit asset.
 *
 * @param pc - `ReadClient` used for the reads.
 * @param vault - Vault address.
 * @param user - Address checked against the senders whitelist.
 * @param assetIn - Deposit asset checked against the assets whitelist; defaults to the reference asset, which is always allowed.
 * @returns A `GateCheck` with sendersGated (a senders whitelist is configured), canSend (user may call deposit/redeem/claim; true when ungated), and assetAllowed (assetIn accepted by the deposit path).
 */
export async function checkGates(pc: ReadClient, vault: Address, user: Address, assetIn?: Address): Promise<GateCheck> {
  const v = { address: vault, abi: tokenizedVaultAbi } as const;
  const [sendersWhitelist, assetsWhitelist, referenceAsset] = await Promise.all([
    pc.readContract({ ...v, functionName: 'sendersWhitelistAddress' }),
    pc.readContract({ ...v, functionName: 'assetsWhitelistAddress' }),
    pc.readContract({ ...v, functionName: 'asset' }),
  ]);
  const sendersGated = sendersWhitelist.toLowerCase() !== zeroAddress;
  const canSend = !sendersGated
    ? true
    : await orOnRevert(pc.readContract({ address: sendersWhitelist, abi: whitelistAbi, functionName: 'isWhitelisted', args: [user] }), false);
  const asset = assetIn ?? referenceAsset;
  const assetAllowed = asset.toLowerCase() === referenceAsset.toLowerCase()
    ? true
    : await orOnRevert(pc.readContract({ address: assetsWhitelist, abi: whitelistAbi, functionName: 'isWhitelisted', args: [asset] }), false);
  return { sendersGated, canSend, assetAllowed };
}

/**
 * Previews a deposit via the vault's on-chain `previewDeposit`.
 *
 * @param pc - `ReadClient` used for the read.
 * @param vault - Vault address.
 * @param assetIn - Deposit asset.
 * @param amountIn - Deposit amount, in the deposit asset's smallest units.
 * @returns An object with `shares` (LP shares that would mint) and `amountInReferenceTokens` (the deposit converted to reference-asset units, used for caps).
 */
export async function previewDeposit(pc: ReadClient, vault: Address, assetIn: Address, amountIn: bigint): Promise<{ shares: bigint; amountInReferenceTokens: bigint }> {
  const [shares, amountInReferenceTokens] = await pc.readContract({
    address: vault, abi: tokenizedVaultAbi, functionName: 'previewDeposit', args: [assetIn, amountIn],
  });
  return { shares, amountInReferenceTokens };
}

/**
 * Previews a redemption via the vault's on-chain `previewRedemption`.
 *
 * @param pc - `ReadClient` used for the read.
 * @param vault - Vault address.
 * @param shares - LP shares to redeem, in the LP token's smallest units.
 * @param instant - True to apply the instant redemption fee, false for the queued (epoch) withdrawal fee.
 * @returns An object with `assetsAmount` (gross assets) and `assetsAfterFee` (assets net of the applicable fee), in reference-asset units.
 */
export async function previewRedemption(pc: ReadClient, vault: Address, shares: bigint, instant: boolean): Promise<{ assetsAmount: bigint; assetsAfterFee: bigint }> {
  const [assetsAmount, assetsAfterFee] = await pc.readContract({
    address: vault, abi: tokenizedVaultAbi, functionName: 'previewRedemption', args: [shares, instant],
  });
  return { assetsAmount, assetsAfterFee };
}

/**
 * Reads the (year, month, day, claimableEpoch) a redemption requested NOW
 * would land on.
 *
 * @param pc - `ReadClient` used for the read.
 * @param vault - Vault address.
 * @returns The claim date fields `year`, `month`, `day` plus `claimableEpoch`, the unix timestamp after which the redemption is claimable.
 */
export async function getWithdrawalEpoch(pc: ReadClient, vault: Address): Promise<ClaimDate & { claimableEpoch: bigint }> {
  const [year, month, day, claimableEpoch] = await pc.readContract({
    address: vault, abi: tokenizedVaultAbi, functionName: 'getWithdrawalEpoch',
  });
  return { year: Number(year), month: Number(month), day: Number(day), claimableEpoch };
}

/**
 * Reads what a receiver can claim for a given epoch date.
 *
 * @param pc - `ReadClient` used for the reads.
 * @param vault - Vault address.
 * @param date - Claim epoch date (year, month, day).
 * @param receiver - Address the redemption was requested for.
 * @returns An object with `shares` (queued shares burnable for the receiver on that date) and `executionEpoch` (unix timestamp after which the claim succeeds).
 */
export async function getClaimable(pc: ReadClient, vault: Address, date: ClaimDate, receiver: Address): Promise<{ shares: bigint; executionEpoch: bigint }> {
  const args = [BigInt(date.year), BigInt(date.month), BigInt(date.day)] as const;
  const [shares, [, executionEpoch]] = await Promise.all([
    pc.readContract({ address: vault, abi: tokenizedVaultAbi, functionName: 'getBurnableAmountByReceiver', args: [...args, receiver] }),
    pc.readContract({ address: vault, abi: tokenizedVaultAbi, functionName: 'getScheduledTransactionsByDate', args: [...args] }),
  ]);
  return { shares, executionEpoch };
}

/** the contract's _TIMESTAMP_MANIPULATION_WINDOW, added to block.timestamp when requestRedeem picks the date */
const TIMESTAMP_MANIPULATION_WINDOW = 300n;

/**
 * Rebuilds the claim date `requestRedeem` assigned to a request from its
 * block time, for when the vault can't be read at the request's block.
 *
 * @param requestedAt - Unix timestamp (seconds) of the block that mined the request.
 * @param lagDuration - The vault's `lagDuration` when the request was mined.
 * @returns The claim date (year, month, day).
 */
export function claimDateForRequest(requestedAt: bigint, lagDuration: bigint): ClaimDate {
  const d = new Date(Number(requestedAt + TIMESTAMP_MANIPULATION_WINDOW + lagDuration) * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export interface WithdrawalRequest {
  /** unix seconds of the block that mined requestRedeem */
  requestedAt: bigint;
  /** lets the vault date the request itself (getWithdrawalEpoch at that block); needs an archive RPC */
  blockNumber?: bigint;
}

export interface PendingWithdrawal {
  date: ClaimDate;
  /** the vault sums every request that landed on the same date */
  shares: bigint;
  claimableEpoch: bigint;
  status: 'pending' | 'claimable';
}

/** caps concurrent reads: historic ones can't share a multicall and rate-limited RPCs answer bursts with 429s */
const READ_BATCH = 8;

async function inBatches<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += READ_BATCH) {
    out.push(...(await Promise.all(items.slice(i, i + READ_BATCH).map(read))));
  }
  return out;
}

export class HistoricEpochUnavailableError extends Error {
  constructor(readonly blockNumber: bigint, options: { cause: unknown }) {
    super(`Could not read getWithdrawalEpoch at block ${blockNumber}`, options);
    this.name = 'HistoricEpochUnavailableError';
  }
}

async function pendingWithdrawals(
  pc: ReadClient, vault: Address, receiver: Address, requests: readonly WithdrawalRequest[], fallBackToCurrentLag: boolean,
): Promise<{ withdrawals: PendingWithdrawal[]; historicReadErrors: HistoricEpochUnavailableError[] }> {
  if (requests.length === 0) return { withdrawals: [], historicReadErrors: [] };
  const blocks = [...new Set(requests.flatMap(({ blockNumber }) => (blockNumber === undefined ? [] : [blockNumber])))];
  const historicReadErrors: HistoricEpochUnavailableError[] = [];
  const [now, epochs] = await Promise.all([
    pc.getBlock().then((b) => b.timestamp),
    inBatches(blocks, (blockNumber) =>
      pc.readContract({ address: vault, abi: tokenizedVaultAbi, functionName: 'getWithdrawalEpoch', blockNumber })
        .catch((cause) => {
          const error = new HistoricEpochUnavailableError(blockNumber, { cause });
          if (!fallBackToCurrentLag) throw error;
          historicReadErrors.push(error);
          return undefined;
        })),
  ]);
  const dateAtBlock = new Map<bigint, ClaimDate>();
  blocks.forEach((b, i) => {
    const epoch = epochs[i];
    if (epoch) dateAtBlock.set(b, { year: Number(epoch[0]), month: Number(epoch[1]), day: Number(epoch[2]) });
  });
  const needsCurrentLag = requests.some(({ blockNumber }) => blockNumber === undefined || !dateAtBlock.has(blockNumber));
  const currentLag = needsCurrentLag
    ? await pc.readContract({ address: vault, abi: tokenizedVaultAbi, functionName: 'lagDuration' })
    : 0n;
  const dates = new Map<string, ClaimDate>();
  for (const { requestedAt, blockNumber } of requests) {
    const date = (blockNumber === undefined ? undefined : dateAtBlock.get(blockNumber)) ?? claimDateForRequest(requestedAt, currentLag);
    dates.set(`${date.year}-${date.month}-${date.day}`, date);
  }
  const found = await inBatches([...dates.values()], async (date) => ({ date, ...(await getClaimable(pc, vault, date, receiver)) }));
  const withdrawals = found
    .filter(({ shares }) => shares > 0n)
    .sort((a, b) => (a.executionEpoch < b.executionEpoch ? -1 : a.executionEpoch > b.executionEpoch ? 1 : 0))
    .map(({ date, shares, executionEpoch }): PendingWithdrawal => ({
      date,
      shares,
      claimableEpoch: executionEpoch,
      // same rule as planClaim's TOO_EARLY, so the two never disagree
      status: now < executionEpoch ? 'pending' : 'claimable',
    }));
  return { withdrawals, historicReadErrors };
}

/**
 * Lists the unpaid queued redemptions for `receiver`, however old. A request
 * with `blockNumber` is dated by the vault itself (`getWithdrawalEpoch` read
 * at that block, which uses that block's timestamp and timelock); one without
 * it is rebuilt with `claimDateForRequest` and the current `lagDuration`,
 * which is wrong if the owner changed the timelock since (no event records it).
 *
 * @param pc - `ReadClient` used for the reads.
 * @param vault - Vault address.
 * @param receiver - Address the redemptions were requested for.
 * @param requests - The `requestRedeem` calls made for `receiver`.
 * @returns One entry per claim date with unpaid shares, oldest first.
 * @throws HistoricEpochUnavailableError when the RPC can't serve state at a request's block.
 */
export async function getPendingWithdrawals(
  pc: ReadClient, vault: Address, receiver: Address, requests: readonly WithdrawalRequest[],
): Promise<PendingWithdrawal[]> {
  return (await pendingWithdrawals(pc, vault, receiver, requests, false)).withdrawals;
}

interface ActivityRow {
  type: string;
  timestamp: string;
  blockNumber: number;
}

export class InvalidActivityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidActivityError';
  }
}

/**
 * Turns yields API activity rows into withdrawal requests, keeping the
 * WITHDRAW_REQUEST ones.
 *
 * @param rows - Activity rows, e.g. from `YieldsClient.getUserVaultActivity`.
 * @returns One request per WITHDRAW_REQUEST row, with its block.
 * @throws InvalidActivityError when the response isn't a list or a request row has a bad timestamp or block.
 */
export function withdrawalRequestsFromActivity(rows: unknown): WithdrawalRequest[] {
  const bad = (what: string, value: unknown) =>
    new InvalidActivityError(`The yields API returned ${what} ${JSON.stringify(String(value).slice(0, 64))}.`);
  if (!Array.isArray(rows)) throw bad('a non-list activity response', typeof rows);
  return (rows as (Partial<ActivityRow> | null)[])
    .filter((row) => row?.type === 'WITHDRAW_REQUEST')
    .map((row) => {
      const ms = Date.parse(String(row!.timestamp));
      if (Number.isNaN(ms)) throw bad('a WITHDRAW_REQUEST with an unparseable timestamp', row!.timestamp);
      const block = row!.blockNumber;
      if (typeof block !== 'number' || !Number.isSafeInteger(block) || block < 0) {
        throw bad('a WITHDRAW_REQUEST with an invalid blockNumber', block);
      }
      return { requestedAt: BigInt(Math.floor(ms / 1000)), blockNumber: BigInt(block) };
    });
}

/**
 * Lists unpaid queued redemptions straight from yields API activity rows.
 * The API indexes WITHDRAW_REQUEST rows under the account that called
 * `requestRedeem`, so pass that account's rows and the receiver they were for.
 * A request whose block the RPC can't read (no archive state, rate limit…)
 * is dated with the current `lagDuration` and its error is returned.
 *
 * @param pc - `ReadClient` used for the reads.
 * @param vault - Vault address.
 * @param receiver - Address the redemptions were requested for.
 * @param rows - Activity rows of the account that called `requestRedeem`.
 * @returns The unpaid withdrawals (see `getPendingWithdrawals`), how many requests the rows held, and the historic reads that failed.
 * @throws InvalidActivityError when the rows are malformed.
 */
export async function getPendingWithdrawalsFromActivity(
  pc: ReadClient, vault: Address, receiver: Address, rows: unknown,
): Promise<{ withdrawals: PendingWithdrawal[]; requestCount: number; historicReadErrors: HistoricEpochUnavailableError[] }> {
  const requests = withdrawalRequestsFromActivity(rows);
  return { ...(await pendingWithdrawals(pc, vault, receiver, requests, true)), requestCount: requests.length };
}

// ---------- writes ----------
// Each write simulates first (readable revert reasons; captures return values).

/**
 * Approves the VAULT to pull the deposit asset: simulates, sends, and waits
 * for the receipt.
 *
 * @param pc - `WriteClient` used to simulate and await the receipt.
 * @param wc - `SignerClient` (any viem `WalletClient` with an account) that signs and sends the transaction.
 * @param asset - ERC-20 deposit asset to approve.
 * @param vault - Vault address that becomes the spender.
 * @param amount - Allowance to grant, in the asset's smallest units.
 * @returns An object with `hash`, the mined transaction hash.
 */
export async function approve(pc: WriteClient, wc: SignerClient, asset: Address, vault: Address, amount: bigint): Promise<{ hash: Hex }> {
  const { hash } = await sendSimulated(pc, wc, { address: asset, abi: erc20Abi, functionName: 'approve', args: [vault, amount] });
  return { hash };
}

/**
 * Approves the VAULT to pull LP shares — required by the QUEUED redeem path
 * only. Simulates, sends, and waits for the receipt.
 *
 * @param pc - `WriteClient` used to simulate and await the receipt.
 * @param wc - `SignerClient` (any viem `WalletClient` with an account) that signs and sends the transaction.
 * @param lpToken - LP share token address, the call target.
 * @param vault - Vault address that becomes the spender.
 * @param shares - Share allowance to grant, in the LP token's smallest units.
 * @returns An object with `hash`, the mined transaction hash.
 */
export async function approveShares(pc: WriteClient, wc: SignerClient, lpToken: Address, vault: Address, shares: bigint): Promise<{ hash: Hex }> {
  const { hash } = await sendSimulated(pc, wc, { address: lpToken, abi: erc20Abi, functionName: 'approve', args: [vault, shares] });
  return { hash };
}

/**
 * Executes a deposit: simulates, sends, and waits for the receipt. LP shares
 * are minted to the receiver.
 *
 * @param pc - `WriteClient` used to simulate and await the receipt.
 * @param wc - `SignerClient` (any viem `WalletClient` with an account) that signs and sends the transaction.
 * @param vault - Vault address, the call target.
 * @param assetIn - Deposit asset (any whitelisted asset or the reference asset).
 * @param amountIn - Deposit amount, in the deposit asset's smallest units.
 * @param receiver - Address the LP shares are minted to.
 * @returns An object with `hash` (transaction hash) and `expectedShares` (shares minted, from the simulated return value).
 */
export async function deposit(pc: WriteClient, wc: SignerClient, vault: Address, assetIn: Address, amountIn: bigint, receiver: Address): Promise<{ hash: Hex; expectedShares: bigint }> {
  const { hash, result } = await sendSimulated(pc, wc, {
    address: vault, abi: tokenizedVaultAbi, functionName: 'deposit', args: [assetIn, amountIn, receiver],
  });
  return { hash, expectedShares: result };
}

export interface RedeemRequestResult {
  hash: Hex;
  claimableEpoch: bigint;
  claimDate: ClaimDate;
}

/**
 * Queues an epoch redemption — needs prior share allowance ≥ shares (see
 * approveShares). Simulates, sends, and waits for the receipt; assets are
 * claimed later with claim(year, month, day, receiver).
 *
 * @param pc - `WriteClient` used to simulate and await the receipt.
 * @param wc - `SignerClient` (any viem `WalletClient` with an account) that signs and sends the transaction.
 * @param vault - Vault address, the call target.
 * @param shares - LP shares to queue, in the LP token's smallest units.
 * @param receiver - Address the assets are claimable for after the epoch.
 * @returns A `RedeemRequestResult` with `hash` (transaction hash), `claimableEpoch` (unix timestamp after which the claim succeeds), and `claimDate` (year, month, day to pass to claim).
 */
export async function requestRedeem(pc: WriteClient, wc: SignerClient, vault: Address, shares: bigint, receiver: Address): Promise<RedeemRequestResult> {
  const { hash, result } = await sendSimulated(pc, wc, {
    address: vault, abi: tokenizedVaultAbi, functionName: 'requestRedeem', args: [shares, receiver],
  });
  const [claimableEpoch, year, month, day] = result;
  return { hash, claimableEpoch, claimDate: { year: Number(year), month: Number(month), day: Number(day) } };
}

/**
 * Executes an instant redemption: simulates, sends, and waits for the receipt.
 * Burns shares directly (no queue, no share allowance) and pays assets
 * immediately, minus the instant redemption fee.
 *
 * @param pc - `WriteClient` used to simulate and await the receipt.
 * @param wc - `SignerClient` (any viem `WalletClient` with an account) that signs and sends the transaction.
 * @param vault - Vault address, the call target.
 * @param shares - LP shares to redeem, in the LP token's smallest units.
 * @param receiver - Address the assets are sent to.
 * @returns An object with `hash`, the mined transaction hash.
 */
export async function instantRedeem(pc: WriteClient, wc: SignerClient, vault: Address, shares: bigint, receiver: Address): Promise<{ hash: Hex }> {
  const { hash } = await sendSimulated(pc, wc, {
    address: vault, abi: tokenizedVaultAbi, functionName: 'instantRedeem', args: [shares, receiver],
  });
  return { hash };
}

/**
 * Claims a queued redemption for an epoch date: simulates, sends, and waits
 * for the receipt.
 *
 * @param pc - `WriteClient` used to simulate and await the receipt.
 * @param wc - `SignerClient` (any viem `WalletClient` with an account) that signs and sends the transaction.
 * @param vault - Vault address, the call target.
 * @param date - Claim epoch date (year, month, day) returned by requestRedeem.
 * @param receiver - Address the redemption was requested for; claim pays this address.
 * @returns An object with `hash` (transaction hash), `assetsAmount` (gross assets), and `assetsAfterFee` (assets net of the withdrawal fee), from the simulated return value.
 */
export async function claim(pc: WriteClient, wc: SignerClient, vault: Address, date: ClaimDate, receiver: Address): Promise<{ hash: Hex; assetsAmount: bigint; assetsAfterFee: bigint }> {
  const { hash, result } = await sendSimulated(pc, wc, {
    address: vault, abi: tokenizedVaultAbi, functionName: 'claim',
    args: [BigInt(date.year), BigInt(date.month), BigInt(date.day), receiver],
  });
  const [assetsAmount, assetsAfterFee] = result;
  return { hash, assetsAmount, assetsAfterFee };
}
