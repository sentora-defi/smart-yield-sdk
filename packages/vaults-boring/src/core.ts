/**
 * Framework-free Boring/Veda primitives. Takes viem clients.
 *
 * KEY DIFFERENCES from ERC-4626 families:
 *  - deposit goes through the TELLER, but the ERC-20 approval target is the VAULT
 *  - deposit mints to msg.sender only (no receiver parameter on the public path)
 *  - withdrawals are an async solver queue; shares are approved to and escrowed
 *    by the QUEUE; the user picks a discount (bps) to attract solvers
 *  - shares can be locked address-wide after a deposit (shareLockPeriod)
 *  - pricing is a pushed oracle rate (getRateInQuoteSafe); it can pause
 */
import { isAddressEqual, parseEventLogs, zeroAddress, zeroHash, type Address, type Hex } from 'viem';
import { isContractRevert, orOnRevert, sendSimulated, type ReadClient, type SignerClient, type WriteClient } from '@sentora/vaults-plan';
import {
  boringVaultAbi, tellerAbi, tellerDepositV2Abi, accountantAbi, boringQueueAbi,
  rolesAuthorityAbi, erc20Abi, TELLER_DEPOSIT_SELECTOR, TELLER_DEPOSIT_SELECTOR_V2, QUEUE_REQUEST_WITHDRAW_SELECTOR,
} from './abi.js';

/** which deposit signature the teller authorizes: 'v1' = 3-arg, 'v2' = 4-arg with referral (LayerZeroTeller) */
export type TellerDepositVariant = 'v1' | 'v2';

/** Per-vault contract topology — Veda deployments wire these per vault. */
export interface BoringVaultConfig {
  vault: Address;          // share token + deposit approval target
  teller: Address;         // deposit entrypoint
  accountant: Address;     // rate source
  queue: Address;          // BoringOnChainQueue — withdrawal entrypoint + share approval target
  rolesAuthority: Address; // permission preflight
  chainId: number;
  label?: string;
}

// ---------- reads ----------

/**
 * True when the vault's RolesAuthority neither makes requestOnChainWithdraw
 * public on the queue nor grants it to any role — how Veda retires a queue
 * after a migration (the old queue keeps reporting the same boringVault()).
 * Read on the vault's authority, not the queue's, so a candidate queue cannot
 * vouch for itself.
 *
 * @param pc - `ReadClient` used for the reads.
 * @param authority - The vault's RolesAuthority (vault.authority()).
 * @param queue - BoringOnChainQueue address.
 * @returns Whether new withdrawal requests are disabled for everyone on this queue.
 */
export async function isQueueDeprecated(pc: ReadClient, authority: Address, queue: Address): Promise<boolean> {
  const [isPublic, roles] = await Promise.allSettled([
    pc.readContract({ address: authority, abi: rolesAuthorityAbi, functionName: 'isCapabilityPublic', args: [queue, QUEUE_REQUEST_WITHDRAW_SELECTOR] }),
    pc.readContract({ address: authority, abi: rolesAuthorityAbi, functionName: 'getRolesWithCapability', args: [queue, QUEUE_REQUEST_WITHDRAW_SELECTOR] }),
  ]);
  if (isPublic.status === 'fulfilled' && isPublic.value) return false;
  if (roles.status === 'fulfilled' && roles.value !== zeroHash) return false;
  if (isPublic.status === 'fulfilled' && roles.status === 'fulfilled') return true;
  // an RPC failure in either read must win over a revert in the other, so callers that fall back on reverts still see it
  const failures = [isPublic, roles].flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
  throw failures[Math.max(0, failures.findIndex((e) => !isContractRevert(e)))];
}

export interface BoringPreflight {
  canDeposit: boolean;      // RolesAuthority.canCall(user, teller, deposit) for EITHER deposit variant
  tellerDepositVariant: TellerDepositVariant;
  tellerPaused: boolean;
  assetAllowed: boolean;
  sharePremiumBps: number;
  shareUnlockTime: bigint;  // address-wide; a NEW deposit re-locks the ENTIRE balance
  sharesLocked: boolean;
}

/**
 * Read-only deposit preflight: checks RolesAuthority permission for both
 * teller deposit variants, teller pause state, asset acceptance, share
 * premium, and the address-wide share lock.
 *
 * @param pc - `ReadClient` used for the reads.
 * @param cfg - Per-vault contract topology.
 * @param asset - Deposit asset to check against the teller's assetData.
 * @param user - Depositor address checked against RolesAuthority and the share lock.
 * @returns A `BoringPreflight` with canDeposit, tellerDepositVariant ('v2' when the 4-arg referral signature is authorized), tellerPaused, assetAllowed, sharePremiumBps, shareUnlockTime, and sharesLocked.
 */
export async function preflight(
  pc: ReadClient, cfg: BoringVaultConfig, asset: Address, user: Address,
): Promise<BoringPreflight> {
  const [canDepositV1, canDepositV2, tellerPaused, assetData, unlock] = await Promise.all([
    pc.readContract({ address: cfg.rolesAuthority, abi: rolesAuthorityAbi, functionName: 'canCall', args: [user, cfg.teller, TELLER_DEPOSIT_SELECTOR] }),
    pc.readContract({ address: cfg.rolesAuthority, abi: rolesAuthorityAbi, functionName: 'canCall', args: [user, cfg.teller, TELLER_DEPOSIT_SELECTOR_V2] }),
    pc.readContract({ address: cfg.teller, abi: tellerAbi, functionName: 'isPaused' }),
    pc.readContract({ address: cfg.teller, abi: tellerAbi, functionName: 'assetData', args: [asset] }),
    // newer teller versions dropped the share-lock feature — treat as never locked
    orOnRevert(pc.readContract({ address: cfg.teller, abi: tellerAbi, functionName: 'shareUnlockTime', args: [user] }), 0n),
  ]);
  const [allowDeposits, , sharePremium] = assetData;
  const now = BigInt(Math.floor(Date.now() / 1000));
  return {
    canDeposit: canDepositV1 || canDepositV2,
    tellerDepositVariant: canDepositV2 ? 'v2' : 'v1',
    tellerPaused,
    assetAllowed: allowDeposits,
    sharePremiumBps: Number(sharePremium),
    shareUnlockTime: unlock,
    sharesLocked: unlock > now,
  };
}

export interface BoringPosition {
  shares: bigint;
  /** value in the quote asset, via the accountant's pushed rate */
  assets: bigint;
  assetBalance: bigint;
  vaultAllowance: bigint;  // asset allowance → vault (deposit path)
  queueShareAllowance: bigint; // share allowance → queue (withdraw path)
}

/**
 * Reads a user's full position: share balance, its value via the accountant's
 * pushed rate, asset balance, and both path-specific allowances.
 *
 * @param pc - `ReadClient` used for the reads.
 * @param cfg - Per-vault contract topology.
 * @param asset - Quote asset for the rate and the balance/allowance reads.
 * @param user - Address whose position is read.
 * @returns A `BoringPosition` with shares, assets (share value in the quote asset), assetBalance, vaultAllowance (asset → vault, deposit path), and queueShareAllowance (shares → queue, withdraw path).
 */
export async function getPosition(
  pc: ReadClient, cfg: BoringVaultConfig, asset: Address, user: Address,
): Promise<BoringPosition> {
  const [shares, decimals, rate, assetBalance, vaultAllowance, queueShareAllowance] = await Promise.all([
    pc.readContract({ address: cfg.vault, abi: boringVaultAbi, functionName: 'balanceOf', args: [user] }),
    pc.readContract({ address: cfg.vault, abi: boringVaultAbi, functionName: 'decimals' }),
    pc.readContract({ address: cfg.accountant, abi: accountantAbi, functionName: 'getRateInQuoteSafe', args: [asset] }),
    pc.readContract({ address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [user] }),
    pc.readContract({ address: asset, abi: erc20Abi, functionName: 'allowance', args: [user, cfg.vault] }),
    pc.readContract({ address: cfg.vault, abi: boringVaultAbi, functionName: 'allowance', args: [user, cfg.queue] }),
  ]);
  const oneShare = 10n ** BigInt(decimals);
  return { shares, assets: (shares * rate) / oneShare, assetBalance, vaultAllowance, queueShareAllowance };
}

/**
 * Previews the shares a deposit would mint. There is NO previewDeposit
 * on-chain — replicates the Teller's math: shares = amount * ONE_SHARE /
 * rateInQuote, then haircut by sharePremium (bps).
 *
 * @param pc - `ReadClient` used for the reads.
 * @param cfg - Per-vault contract topology.
 * @param asset - Deposit asset used for the rate and sharePremium lookups.
 * @param amount - Deposit amount, in the asset's smallest units.
 * @returns The expected shares to mint, after the sharePremium haircut.
 */
export async function previewDepositShares(
  pc: ReadClient, cfg: BoringVaultConfig, asset: Address, amount: bigint,
): Promise<bigint> {
  const [decimals, rate, assetData] = await Promise.all([
    pc.readContract({ address: cfg.vault, abi: boringVaultAbi, functionName: 'decimals' }),
    pc.readContract({ address: cfg.accountant, abi: accountantAbi, functionName: 'getRateInQuoteSafe', args: [asset] }),
    pc.readContract({ address: cfg.teller, abi: tellerAbi, functionName: 'assetData', args: [asset] }),
  ]);
  const [, , sharePremium] = assetData;
  const oneShare = 10n ** BigInt(decimals);
  const raw = (amount * oneShare) / rate;
  return (raw * (10_000n - BigInt(sharePremium))) / 10_000n;
}

export interface WithdrawAssetConfig {
  allowWithdraws: boolean;
  secondsToMaturity: number;
  minimumSecondsToDeadline: number;
  minDiscountBps: number;
  maxDiscountBps: number;
  minimumShares: bigint;
}

/**
 * Reads the queue's per-asset withdrawal configuration.
 *
 * @param pc - `ReadClient` used for the read.
 * @param cfg - Per-vault contract topology; `cfg.queue` is queried.
 * @param assetOut - Withdrawal asset whose queue configuration is read.
 * @returns A `WithdrawAssetConfig` with allowWithdraws, secondsToMaturity, minimumSecondsToDeadline, minDiscountBps, maxDiscountBps, and minimumShares.
 */
export async function getWithdrawAssetConfig(
  pc: ReadClient, cfg: BoringVaultConfig, assetOut: Address,
): Promise<WithdrawAssetConfig> {
  const [allowWithdraws, secondsToMaturity, minimumSecondsToDeadline, minDiscount, maxDiscount, minimumShares] =
    await pc.readContract({ address: cfg.queue, abi: boringQueueAbi, functionName: 'withdrawAssets', args: [assetOut] });
  return {
    allowWithdraws,
    secondsToMaturity: Number(secondsToMaturity),
    minimumSecondsToDeadline: Number(minimumSecondsToDeadline),
    minDiscountBps: Number(minDiscount),
    maxDiscountBps: Number(maxDiscount),
    minimumShares,
  };
}

/**
 * Previews the assets a queued withdrawal would pay out via the queue's
 * `previewAssetsOut`.
 *
 * @param pc - `ReadClient` used for the read.
 * @param cfg - Per-vault contract topology; `cfg.queue` is queried.
 * @param assetOut - Withdrawal asset.
 * @param shares - Vault shares to withdraw (uint128 on-chain).
 * @param discountBps - Discount (basis points) applied for solvers.
 * @returns The expected asset payout, in the asset's smallest units.
 */
export async function previewWithdrawAssets(
  pc: ReadClient, cfg: BoringVaultConfig, assetOut: Address, shares: bigint, discountBps: number,
): Promise<bigint> {
  return pc.readContract({
    address: cfg.queue, abi: boringQueueAbi, functionName: 'previewAssetsOut',
    args: [assetOut, shares as unknown as bigint & { __uint128: true }, discountBps],
  }) as Promise<bigint>;
}

// ---------- writes ----------

/**
 * Approves the VAULT (not the teller!) to pull the deposit asset: simulates,
 * sends, and waits for the receipt.
 *
 * @param pc - `WriteClient` used to simulate and await the receipt.
 * @param wc - `SignerClient` (any viem `WalletClient` with an account) that signs and sends the transaction.
 * @param cfg - Per-vault contract topology; `cfg.vault` is the spender.
 * @param asset - ERC-20 deposit asset to approve.
 * @param amount - Allowance to grant, in the asset's smallest units.
 * @returns An object with `hash`, the mined transaction hash.
 */
export async function approveAsset(
  pc: WriteClient, wc: SignerClient, cfg: BoringVaultConfig, asset: Address, amount: bigint,
): Promise<{ hash: Hex }> {
  const { hash } = await sendSimulated(pc, wc, {
    address: asset, abi: erc20Abi, functionName: 'approve', args: [cfg.vault, amount],
  });
  return { hash };
}

/**
 * Executes a teller deposit: simulates, sends, and waits for the receipt.
 * Shares mint to msg.sender. minimumMint must already account for
 * sharePremium — use previewDepositShares with slippage.
 *
 * @param pc - `WriteClient` used to simulate and await the receipt.
 * @param wc - `SignerClient` (any viem `WalletClient` with an account) that signs and sends the transaction.
 * @param cfg - Per-vault contract topology; `cfg.teller` is the call target.
 * @param asset - ERC-20 deposit asset.
 * @param amount - Deposit amount, in the asset's smallest units.
 * @param minimumMint - Minimum shares to mint or the deposit reverts.
 * @param variant - Teller deposit signature, from preflight's `tellerDepositVariant`; `'v2'` calls the 4-arg referral deposit.
 * @param referral - Referral address for the `'v2'` deposit; ignored by `'v1'`. Defaults to the zero address.
 * @returns An object with `hash` (transaction hash) and `shares` (shares minted, from the simulated return value).
 */
export async function deposit(
  pc: WriteClient, wc: SignerClient, cfg: BoringVaultConfig, asset: Address, amount: bigint, minimumMint: bigint,
  variant: TellerDepositVariant = 'v1', referral: Address = zeroAddress,
): Promise<{ hash: Hex; shares: bigint }> {
  const { hash, result } = variant === 'v2'
    ? await sendSimulated(pc, wc, {
      address: cfg.teller, abi: tellerDepositV2Abi, functionName: 'deposit', args: [asset, amount, minimumMint, referral],
    })
    : await sendSimulated(pc, wc, {
      address: cfg.teller, abi: tellerAbi, functionName: 'deposit', args: [asset, amount, minimumMint],
    });
  return { hash, shares: result };
}

/**
 * Approves SHARES to the QUEUE — the withdraw path's approval target differs
 * from the deposit path's. Simulates, sends, and waits for the receipt.
 *
 * @param pc - `WriteClient` used to simulate and await the receipt.
 * @param wc - `SignerClient` (any viem `WalletClient` with an account) that signs and sends the transaction.
 * @param cfg - Per-vault contract topology; `cfg.queue` is the spender, `cfg.vault` (the share token) is the call target.
 * @param shares - Share allowance to grant, in the share token's smallest units.
 * @returns An object with `hash`, the mined transaction hash.
 */
export async function approveSharesToQueue(
  pc: WriteClient, wc: SignerClient, cfg: BoringVaultConfig, shares: bigint,
): Promise<{ hash: Hex }> {
  const { hash } = await sendSimulated(pc, wc, {
    address: cfg.vault, abi: boringVaultAbi, functionName: 'approve', args: [cfg.queue, shares],
  });
  return { hash };
}

export interface OnChainWithdrawRequest {
  nonce: bigint; user: Address; assetOut: Address;
  amountOfShares: bigint; amountOfAssets: bigint;
  creationTime: number; secondsToMaturity: number; secondsToDeadline: number;
}

/**
 * Queues a withdrawal on the solver queue: simulates, sends, and waits for the
 * receipt. Returns the requestId AND the full request struct decoded from the
 * OnChainWithdrawRequested event — PERSIST THE STRUCT: cancel/replace take the
 * full 8-field tuple, not the id.
 *
 * @param pc - `WriteClient` used to simulate and await the receipt.
 * @param wc - `SignerClient` (any viem `WalletClient` with an account) that signs and sends the transaction.
 * @param cfg - Per-vault contract topology; `cfg.queue` is the call target.
 * @param assetOut - ERC-20 asset the withdrawal should pay out in.
 * @param shares - Vault shares to queue, in the share token's smallest units.
 * @param discountBps - Discount (basis points) offered to solvers.
 * @param secondsToDeadline - Request validity window in seconds.
 * @returns An object with `hash` (transaction hash), `requestId` (queue request id, from the event), and `request` (the OnChainWithdrawRequest struct decoded from the event).
 * @throws If the mined receipt has no OnChainWithdrawRequested event from `cfg.queue`.
 */
export async function requestWithdraw(
  pc: WriteClient, wc: SignerClient, cfg: BoringVaultConfig,
  assetOut: Address, shares: bigint, discountBps: number, secondsToDeadline: number,
): Promise<{ hash: Hex; requestId: Hex; request: OnChainWithdrawRequest }> {
  const { hash, logs } = await sendSimulated(pc, wc, {
    address: cfg.queue, abi: boringQueueAbi, functionName: 'requestOnChainWithdraw',
    args: [assetOut, shares, discountBps, secondsToDeadline],
  });

  const event = parseEventLogs({ abi: boringQueueAbi, logs, eventName: 'OnChainWithdrawRequested' })
    .find((e) => isAddressEqual(e.address, cfg.queue));
  // the simulated id is no fallback: the queue hashes the mined creationTime into it
  if (event === undefined) {
    throw new Error(`@sentora/vaults-boring: transaction ${hash} mined without an OnChainWithdrawRequested event from queue ${cfg.queue}.`);
  }
  const request: OnChainWithdrawRequest = {
    nonce: event.args.nonce, user: event.args.user, assetOut: event.args.assetOut,
    amountOfShares: event.args.amountOfShares, amountOfAssets: event.args.amountOfAssets,
    creationTime: event.args.creationTime, secondsToMaturity: event.args.secondsToMaturity,
    secondsToDeadline: event.args.secondsToDeadline,
  };

  return { hash, requestId: event.args.requestId, request };
}

/**
 * Cancels a pending withdrawal — needs the full persisted struct. Shares
 * return to the user. Simulates, sends, and waits for the receipt.
 *
 * @param pc - `WriteClient` used to simulate and await the receipt.
 * @param wc - `SignerClient` (any viem `WalletClient` with an account) that signs and sends the transaction.
 * @param cfg - Per-vault contract topology; `cfg.queue` is the call target.
 * @param request - The full 8-field OnChainWithdrawRequest struct persisted from the requestWithdraw event.
 * @returns An object with `hash`, the mined transaction hash.
 */
export async function cancelWithdraw(
  pc: WriteClient, wc: SignerClient, cfg: BoringVaultConfig, request: OnChainWithdrawRequest,
): Promise<{ hash: Hex }> {
  const { hash } = await sendSimulated(pc, wc, {
    address: cfg.queue, abi: boringQueueAbi, functionName: 'cancelOnChainWithdraw',
    args: [{
      nonce: request.nonce, user: request.user, assetOut: request.assetOut,
      amountOfShares: request.amountOfShares, amountOfAssets: request.amountOfAssets,
      creationTime: request.creationTime, secondsToMaturity: request.secondsToMaturity,
      secondsToDeadline: request.secondsToDeadline,
    }],
  });
  return { hash };
}

/**
 * Checks whether a withdrawal request is still pending (present in the
 * queue's live id set).
 *
 * @param pc - `ReadClient` used for the read.
 * @param cfg - Per-vault contract topology; `cfg.queue` is queried.
 * @param requestId - The request id returned by requestWithdraw.
 * @returns True if the id is present in the queue's live request-id set.
 */
export async function isRequestPending(pc: ReadClient, cfg: BoringVaultConfig, requestId: Hex): Promise<boolean> {
  const ids = await pc.readContract({ address: cfg.queue, abi: boringQueueAbi, functionName: 'getRequestIds' });
  return ids.includes(requestId);
}
