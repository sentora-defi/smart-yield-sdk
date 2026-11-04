/** Pure calldata builders — no RPC, no signer. */
import { encodeFunctionData, zeroAddress, type Address } from 'viem';
import type { TxStep } from '@sentora/vaults-plan';
import { boringVaultAbi, tellerAbi, tellerDepositV2Abi, boringQueueAbi, erc20Abi } from './abi.js';
import type { BoringVaultConfig, TellerDepositVariant } from './core.js';

/**
 * Builds the ERC-20 approve calldata for the deposit asset. Approval target is
 * the VAULT, not the teller.
 *
 * @param cfg - Per-vault contract topology; `cfg.vault` is the spender.
 * @param asset - ERC-20 deposit asset to approve.
 * @param amount - Allowance to grant, in the asset's smallest units.
 * @returns An unsigned `TxStep` (kind `approve`) with the target address, calldata, description, and zero value.
 */
export function encodeApproveAsset(cfg: BoringVaultConfig, asset: Address, amount: bigint): TxStep {
  return {
    kind: 'approve',
    description: `Approve the VAULT (not the teller) to pull ${amount} units of the deposit asset`,
    to: asset,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [cfg.vault, amount] }),
    value: '0',
  };
}

/**
 * Builds calldata that resets the asset allowance to zero. Reset step for
 * tokens (USDT et al.) that revert on nonzero->nonzero approve.
 *
 * @param cfg - Per-vault contract topology; `cfg.vault` is the spender being reset.
 * @param asset - ERC-20 deposit asset whose allowance is reset to 0.
 * @returns An unsigned `TxStep` (kind `approveReset`) with the target address, calldata, description, and zero value.
 */
export function encodeApproveAssetReset(cfg: BoringVaultConfig, asset: Address): TxStep {
  return {
    kind: 'approveReset',
    description: 'Reset the residual asset allowance to 0 first (some tokens revert on nonzero-to-nonzero approve)',
    to: asset,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [cfg.vault, 0n] }),
    value: '0',
  };
}

/**
 * Builds the teller deposit calldata — shares are minted to msg.sender in BOTH
 * variants; the v2 (LayerZeroTeller) signature adds a referral address as its
 * 4th argument.
 *
 * @param cfg - Per-vault contract topology; `cfg.teller` is the call target.
 * @param asset - ERC-20 deposit asset.
 * @param amount - Deposit amount, in the asset's smallest units.
 * @param minimumMint - Minimum shares to mint or the deposit reverts (slippage guard).
 * @param variant - Teller deposit signature: `'v1'` = 3-arg (default), `'v2'` = 4-arg with referral.
 * @param referral - Referral address for the v2 signature only (defaults to the zero address).
 * @returns An unsigned `TxStep` (kind `deposit`) with the teller as target, encoded calldata, description, and zero value.
 */
export function encodeDeposit(
  cfg: BoringVaultConfig, asset: Address, amount: bigint, minimumMint: bigint,
  variant: TellerDepositVariant = 'v1', referral: Address = zeroAddress,
): TxStep {
  return {
    kind: 'deposit',
    description: `Teller deposit of ${amount} asset units, minimumMint ${minimumMint} shares (minted to the sender)`,
    to: cfg.teller,
    data: variant === 'v2'
      ? encodeFunctionData({ abi: tellerDepositV2Abi, functionName: 'deposit', args: [asset, amount, minimumMint, referral] })
      : encodeFunctionData({ abi: tellerAbi, functionName: 'deposit', args: [asset, amount, minimumMint] }),
    value: '0',
  };
}

/**
 * Builds calldata approving vault shares to the queue. Withdrawal path
 * approves SHARES to the QUEUE (unlike the deposit path, which approves the
 * asset to the vault).
 *
 * @param cfg - Per-vault contract topology; `cfg.queue` is the spender, `cfg.vault` (the share token) is the call target.
 * @param shares - Share allowance to grant, in the vault share token's smallest units.
 * @returns An unsigned `TxStep` (kind `approveShares`) with the vault as target, encoded calldata, description, and zero value.
 */
export function encodeApproveSharesToQueue(cfg: BoringVaultConfig, shares: bigint): TxStep {
  return {
    kind: 'approveShares',
    description: `Approve the queue to escrow ${shares} vault shares`,
    to: cfg.vault,
    data: encodeFunctionData({ abi: boringVaultAbi, functionName: 'approve', args: [cfg.queue, shares] }),
    value: '0',
  };
}

/**
 * Builds the calldata for `requestOnChainWithdraw` on the solver queue. The
 * receipt's OnChainWithdrawRequested event struct must be persisted —
 * cancel/replace need the full tuple.
 *
 * @param cfg - Per-vault contract topology; `cfg.queue` is the call target.
 * @param assetOut - ERC-20 asset the withdrawal should pay out in.
 * @param shares - Vault shares to queue for withdrawal, in the share token's smallest units.
 * @param discountBps - Discount (basis points) offered to solvers to fill the request.
 * @param secondsToDeadline - Request validity window in seconds (uint24).
 * @returns An unsigned `TxStep` (kind `requestWithdraw`) with the queue as target, encoded calldata, description, and zero value.
 */
export function encodeRequestWithdraw(
  cfg: BoringVaultConfig, assetOut: Address, shares: bigint, discountBps: number, secondsToDeadline: number,
): TxStep {
  return {
    kind: 'requestWithdraw',
    description: `Queue withdrawal of ${shares} shares into the solver queue at ${discountBps} bps discount, deadline ${secondsToDeadline}s. PERSIST the OnChainWithdrawRequested event struct — cancel/replace need the full tuple.`,
    to: cfg.queue,
    data: encodeFunctionData({
      abi: boringQueueAbi, functionName: 'requestOnChainWithdraw',
      args: [assetOut, shares, discountBps, secondsToDeadline],
    }),
    value: '0',
  };
}
