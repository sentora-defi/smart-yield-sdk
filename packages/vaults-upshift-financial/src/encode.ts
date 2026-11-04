/** Pure calldata builders returning TxSteps for the shared plan envelope. */
import { encodeFunctionData, type Address } from 'viem';
import type { TxStep } from '@sentora/vaults-plan';
import { zeroValue } from '@sentora/vaults-plan';
import { tokenizedVaultAbi, erc20Abi } from './abi.js';
import type { ClaimDate } from './core.js';

/**
 * Builds the ERC-20 approve calldata letting the vault pull the deposit asset.
 *
 * @param asset - ERC-20 deposit asset to approve.
 * @param vault - Vault address that becomes the spender.
 * @param amount - Allowance to grant, in the asset's smallest units.
 * @returns An unsigned `TxStep` (kind `approve`) with the asset as target, encoded calldata, description, and zero value.
 */
export function encodeApprove(asset: Address, vault: Address, amount: bigint): TxStep {
  return {
    kind: 'approve',
    description: `Approve the vault to pull ${amount} units of the deposit asset`,
    to: asset,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [vault, amount] }),
    value: zeroValue,
  };
}

/**
 * Builds calldata that resets the asset allowance to zero. Reset step for
 * tokens (USDT et al.) that revert on nonzero->nonzero approve.
 *
 * @param asset - ERC-20 deposit asset whose allowance is reset to 0.
 * @param vault - Vault address (the spender) whose granted allowance is reset to 0.
 * @returns An unsigned `TxStep` (kind `approveReset`) with the asset as target, encoded calldata, description, and zero value.
 */
export function encodeApproveReset(asset: Address, vault: Address): TxStep {
  return {
    kind: 'approveReset',
    description: 'Reset the residual asset allowance to 0 first (some tokens revert on nonzero-to-nonzero approve)',
    to: asset,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [vault, 0n] }),
    value: zeroValue,
  };
}

/**
 * Builds calldata approving LP shares to the vault, required for the QUEUED
 * redemption path which escrows shares via transferFrom (instant redemption
 * needs no allowance).
 *
 * @param lpToken - LP share token address (the vault is not the share token).
 * @param vault - Vault address that becomes the spender.
 * @param shares - Share allowance to grant, in the LP token's smallest units.
 * @returns An unsigned `TxStep` (kind `approveShares`) with the LP token as target, encoded calldata, description, and zero value.
 */
export function encodeApproveShares(lpToken: Address, vault: Address, shares: bigint): TxStep {
  return {
    kind: 'approveShares',
    description: `Approve the vault to pull ${shares} LP shares (queued redemption escrow)`,
    to: lpToken,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [vault, shares] }),
    value: zeroValue,
  };
}

/**
 * Builds the multi-asset deposit calldata; LP shares are minted to the
 * receiver.
 *
 * @param vault - Vault address, the call target.
 * @param assetIn - Deposit asset (any whitelisted asset or the reference asset).
 * @param amountIn - Deposit amount, in the deposit asset's smallest units.
 * @param receiver - Address the LP shares are minted to.
 * @returns An unsigned `TxStep` (kind `deposit`) with the vault as target, encoded calldata, description, and zero value.
 */
export function encodeDeposit(vault: Address, assetIn: Address, amountIn: bigint, receiver: Address): TxStep {
  return {
    kind: 'deposit',
    description: `Deposit ${amountIn} units of ${assetIn}, LP shares to ${receiver}`,
    to: vault,
    data: encodeFunctionData({ abi: tokenizedVaultAbi, functionName: 'deposit', args: [assetIn, amountIn, receiver] }),
    value: zeroValue,
  };
}

/**
 * Builds the queued (epoch) redemption calldata; assets are paid out via a
 * later claim after the claim epoch, not in this transaction.
 *
 * @param vault - Vault address, the call target.
 * @param shares - LP shares to queue for redemption, in the LP token's smallest units.
 * @param receiver - Address the assets are claimable for after the epoch.
 * @returns An unsigned `TxStep` (kind `requestRedeem`) with the vault as target, encoded calldata, description, and zero value.
 */
export function encodeRequestRedeem(vault: Address, shares: bigint, receiver: Address): TxStep {
  return {
    kind: 'requestRedeem',
    description: `Queue redemption of ${shares} shares; assets to ${receiver} after the claim epoch`,
    to: vault,
    data: encodeFunctionData({ abi: tokenizedVaultAbi, functionName: 'requestRedeem', args: [shares, receiver] }),
    value: zeroValue,
  };
}

/**
 * Builds the instant redemption calldata: shares are burned directly (no
 * queue, no share allowance) and assets are paid immediately, minus the
 * instant redemption fee.
 *
 * @param vault - Vault address, the call target.
 * @param shares - LP shares to redeem, in the LP token's smallest units.
 * @param receiver - Address the assets are sent to.
 * @returns An unsigned `TxStep` (kind `instantRedeem`) with the vault as target, encoded calldata, description, and zero value.
 */
export function encodeInstantRedeem(vault: Address, shares: bigint, receiver: Address): TxStep {
  return {
    kind: 'instantRedeem',
    description: `Instant redemption of ${shares} shares (fee applies), assets to ${receiver}`,
    to: vault,
    data: encodeFunctionData({ abi: tokenizedVaultAbi, functionName: 'instantRedeem', args: [shares, receiver] }),
    value: zeroValue,
  };
}

/**
 * Builds the calldata claiming a queued redemption for a given epoch date.
 *
 * @param vault - Vault address, the call target.
 * @param date - Claim epoch date (year, month, day) returned by the redemption request.
 * @param receiver - Address the redemption was requested for; claim pays this address.
 * @returns An unsigned `TxStep` (kind `claim`) with the vault as target, encoded calldata, description, and zero value.
 */
export function encodeClaim(vault: Address, date: ClaimDate, receiver: Address): TxStep {
  return {
    kind: 'claim',
    description: `Claim the queued redemption of ${date.year}-${date.month}-${date.day} to ${receiver}`,
    to: vault,
    data: encodeFunctionData({
      abi: tokenizedVaultAbi, functionName: 'claim',
      args: [BigInt(date.year), BigInt(date.month), BigInt(date.day), receiver],
    }),
    value: zeroValue,
  };
}
