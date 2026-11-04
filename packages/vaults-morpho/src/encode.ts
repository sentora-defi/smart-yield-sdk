/** Pure calldata builders — no RPC, no signer. NEVER approve Bundler3. */
import { encodeFunctionData, type Address } from 'viem';
import type { TxStep } from '@sentora/vaults-plan';
import { morphoVaultAbi, erc20Abi } from './abi.js';

/**
 * Builds the calldata step approving the vault to pull the underlying asset.
 * Pure calldata builder — no RPC, no signer. NEVER approve Bundler3.
 * @param asset ERC-20 underlying asset to approve.
 * @param vault Morpho vault granted the allowance (the spender).
 * @param amount Allowance in raw asset units (asset decimals).
 * @returns Unsigned approve TxStep (kind, description, to, data, value).
 */
export function encodeApprove(asset: Address, vault: Address, amount: bigint): TxStep {
  return {
    kind: 'approve',
    description: `Approve the vault to pull ${amount} units of the underlying asset`,
    to: asset,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [vault, amount] }),
    value: '0',
  };
}

/**
 * Builds the calldata step resetting the asset allowance to zero. Reset step for
 * tokens (USDT et al.) that revert on nonzero->nonzero approve.
 * @param asset ERC-20 underlying asset whose allowance is reset.
 * @param vault Morpho vault whose allowance is zeroed (the spender).
 * @returns Unsigned approveReset TxStep (kind, description, to, data, value).
 */
export function encodeApproveReset(asset: Address, vault: Address): TxStep {
  return {
    kind: 'approveReset',
    description: 'Reset the residual asset allowance to 0 first (some tokens revert on nonzero-to-nonzero approve)',
    to: asset,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [vault, 0n] }),
    value: '0',
  };
}

/**
 * Builds the calldata step for an ERC-4626 deposit into the vault.
 * @param vault Morpho vault to deposit into.
 * @param assets Amount to deposit in raw asset units (asset decimals).
 * @param receiver Address credited with the minted shares.
 * @returns Unsigned deposit TxStep (kind, description, to, data, value).
 */
export function encodeDeposit(vault: Address, assets: bigint, receiver: Address): TxStep {
  return {
    kind: 'deposit',
    description: `ERC-4626 deposit of ${assets} asset units, shares to ${receiver}`,
    to: vault,
    data: encodeFunctionData({ abi: morphoVaultAbi, functionName: 'deposit', args: [assets, receiver] }),
    value: '0',
  };
}

/**
 * Builds the calldata step for an exact-shares redemption from the vault. The
 * call reverts onchain if underlying market liquidity is insufficient.
 * @param vault Morpho vault to redeem from.
 * @param shares Amount of vault shares to redeem (share decimals).
 * @param receiver Address that receives the underlying assets.
 * @param owner Address whose shares are burned.
 * @returns Unsigned redeem TxStep (kind, description, to, data, value).
 */
export function encodeRedeem(vault: Address, shares: bigint, receiver: Address, owner: Address): TxStep {
  return {
    kind: 'redeem',
    description: `Redeem ${shares} shares to ${receiver} (reverts if underlying market liquidity is insufficient)`,
    to: vault,
    data: encodeFunctionData({ abi: morphoVaultAbi, functionName: 'redeem', args: [shares, receiver, owner] }),
    value: '0',
  };
}

/**
 * Builds the calldata step for an exact-assets withdrawal from the vault. The
 * call reverts onchain if underlying market liquidity is insufficient.
 * @param vault Morpho vault to withdraw from.
 * @param assets Amount to withdraw in raw asset units (asset decimals).
 * @param receiver Address that receives the underlying assets.
 * @param owner Address whose shares are burned.
 * @returns Unsigned withdraw TxStep (kind, description, to, data, value).
 */
export function encodeWithdraw(vault: Address, assets: bigint, receiver: Address, owner: Address): TxStep {
  return {
    kind: 'withdraw',
    description: `Withdraw ${assets} asset units to ${receiver} (reverts if underlying market liquidity is insufficient)`,
    to: vault,
    data: encodeFunctionData({ abi: morphoVaultAbi, functionName: 'withdraw', args: [assets, receiver, owner] }),
    value: '0',
  };
}
