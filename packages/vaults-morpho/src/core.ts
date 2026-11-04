/**
 * Framework-free Morpho Vaults primitives (V1 MetaMorpho + V2). Takes viem clients.
 * Approval target: the vault itself (direct path, no bundler3/GeneralAdapter1
 * batching): approve and deposit are separate transactions, and deposit/redeem
 * carry no slippage bound. NEVER approve Bundler3.
 */
import type { Address, Hex } from 'viem';
import { isContractRevert, orOnRevert, sendSimulated, type ReadClient, type SignerClient, type WriteClient } from '@sentora/vaults-plan';
import { morphoVaultAbi, gateAbi, erc20Abi } from './abi.js';

export interface MorphoVaultMeta {
  vault: Address;
  shareSymbol: string;
  shareDecimals: number;
  asset: Address;
  assetSymbol: string;
  assetDecimals: number;
  totalAssets: bigint;
  /** true when the vault exposes V2 gate getters */
  isV2: boolean;
}

/**
 * Reads static vault and underlying-asset metadata via RPC, detecting V2 by
 * probing the receiveSharesGate getter.
 * @param pc `ReadClient` used for the reads.
 * @param vault Morpho vault (V1 MetaMorpho or V2) to inspect.
 * @returns Vault address, share symbol/decimals, asset address/symbol/decimals, totalAssets, and the isV2 flag.
 */
export async function getVaultMeta(pc: ReadClient, vault: Address): Promise<MorphoVaultMeta> {
  const [shareSymbol, shareDecimals, asset, totalAssets] = await Promise.all([
    pc.readContract({ address: vault, abi: morphoVaultAbi, functionName: 'symbol' }),
    pc.readContract({ address: vault, abi: morphoVaultAbi, functionName: 'decimals' }),
    pc.readContract({ address: vault, abi: morphoVaultAbi, functionName: 'asset' }),
    pc.readContract({ address: vault, abi: morphoVaultAbi, functionName: 'totalAssets' }),
  ]);
  const [assetSymbol, assetDecimals] = await Promise.all([
    pc.readContract({ address: asset, abi: erc20Abi, functionName: 'symbol' }),
    pc.readContract({ address: asset, abi: erc20Abi, functionName: 'decimals' }),
  ]);
  let isV2 = false;
  try {
    await pc.readContract({ address: vault, abi: morphoVaultAbi, functionName: 'receiveSharesGate' });
    isV2 = true;
  } catch (e) {
    if (!isContractRevert(e)) throw e;
  }
  return { vault, shareSymbol, shareDecimals, asset, assetSymbol, assetDecimals, totalAssets, isV2 };
}

export interface MorphoPosition {
  shares: bigint;
  assets: bigint;
  assetBalance: bigint;
  allowance: bigint;
  /**
   * V1: real, liquidity-aware. V2: ALWAYS 0 by design — do not use for UI caps.
   */
  maxWithdrawRaw: bigint;
}

/**
 * Reads the user's live position in the vault. maxWithdrawRaw is real and
 * liquidity-aware on V1 but ALWAYS 0 on V2 by design — do not use it for UI caps.
 * @param pc `ReadClient` used for the reads.
 * @param vault Morpho vault to query.
 * @param asset Underlying ERC-20 asset of the vault.
 * @param user Address whose balances and allowance are read.
 * @returns Shares, their asset value, wallet asset balance, vault allowance, and maxWithdrawRaw.
 */
export async function getPosition(pc: ReadClient, vault: Address, asset: Address, user: Address): Promise<MorphoPosition> {
  const [shares, assetBalance, allowance, maxWithdrawRaw] = await Promise.all([
    pc.readContract({ address: vault, abi: morphoVaultAbi, functionName: 'balanceOf', args: [user] }),
    pc.readContract({ address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [user] }),
    pc.readContract({ address: asset, abi: erc20Abi, functionName: 'allowance', args: [user, vault] }),
    orOnRevert(pc.readContract({ address: vault, abi: morphoVaultAbi, functionName: 'maxWithdraw', args: [user] }), 0n),
  ]);
  const assets = shares > 0n
    ? await pc.readContract({ address: vault, abi: morphoVaultAbi, functionName: 'convertToAssets', args: [shares] })
    : 0n;
  return { shares, assets, assetBalance, allowance, maxWithdrawRaw };
}

export interface GateCheck {
  gated: boolean;         // any gate configured
  canDeposit: boolean;    // sendAssetsGate(user) && receiveSharesGate(user); true when ungated
  canWithdraw: boolean;   // sendSharesGate(user) && receiveAssetsGate(user); true when ungated
}

const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * V2 gate preflight — cheap boolean eligibility before offering deposit/withdraw.
 * V1 vaults (no gate getters) report ungated with everything allowed.
 * NOTE: sendAssetsGate is checked against msg.sender onchain; on the direct path
 * that IS the user, but on a bundler path it would be the adapter.
 * @param pc `ReadClient` used for the reads.
 * @param vault Morpho vault whose gates are probed.
 * @param user Address checked against each configured gate.
 * @returns Whether any gate is configured (gated) plus canDeposit and canWithdraw eligibility flags.
 */
export async function checkGates(pc: ReadClient, vault: Address, user: Address): Promise<GateCheck> {
  let addrs: [Address, Address, Address, Address];
  try {
    addrs = await Promise.all([
      pc.readContract({ address: vault, abi: morphoVaultAbi, functionName: 'receiveSharesGate' }),
      pc.readContract({ address: vault, abi: morphoVaultAbi, functionName: 'sendSharesGate' }),
      pc.readContract({ address: vault, abi: morphoVaultAbi, functionName: 'receiveAssetsGate' }),
      pc.readContract({ address: vault, abi: morphoVaultAbi, functionName: 'sendAssetsGate' }),
    ]) as [Address, Address, Address, Address];
  } catch (e) {
    if (!isContractRevert(e)) throw e;
    return { gated: false, canDeposit: true, canWithdraw: true }; // V1 — no gates
  }
  const [recvShares, sendShares, recvAssets, sendAssets] = addrs;
  const gated = addrs.some(a => a.toLowerCase() !== ZERO);
  const call = async (gate: Address, fn: 'canReceiveShares' | 'canSendShares' | 'canReceiveAssets' | 'canSendAssets') =>
    gate.toLowerCase() === ZERO
      ? true
      : orOnRevert(pc.readContract({ address: gate, abi: gateAbi, functionName: fn, args: [user] }), false);
  const [dep1, dep2, wit1, wit2] = await Promise.all([
    call(recvShares, 'canReceiveShares'), call(sendAssets, 'canSendAssets'),
    call(sendShares, 'canSendShares'), call(recvAssets, 'canReceiveAssets'),
  ]);
  return { gated, canDeposit: dep1 && dep2, canWithdraw: wit1 && wit2 };
}

/**
 * Quotes the shares minted for a deposit via the vault's previewDeposit.
 * @param pc `ReadClient` used for the read.
 * @param vault Morpho vault to quote against.
 * @param assets Deposit amount in raw asset units (asset decimals).
 * @returns Shares that would be minted, in raw share units.
 */
export async function previewDeposit(pc: ReadClient, vault: Address, assets: bigint): Promise<bigint> {
  return pc.readContract({ address: vault, abi: morphoVaultAbi, functionName: 'previewDeposit', args: [assets] });
}
/**
 * Quotes the assets returned for a redemption via the vault's previewRedeem.
 * @param pc `ReadClient` used for the read.
 * @param vault Morpho vault to quote against.
 * @param shares Amount of vault shares to quote, in raw share units.
 * @returns Underlying assets that would be paid out, in raw asset units.
 */
export async function previewRedeem(pc: ReadClient, vault: Address, shares: bigint): Promise<bigint> {
  return pc.readContract({ address: vault, abi: morphoVaultAbi, functionName: 'previewRedeem', args: [shares] });
}

// ---------- writes ----------

/**
 * Approves the vault to pull the underlying asset: simulates, sends, and waits
 * for the receipt. NEVER approve Bundler3.
 * @param pc `WriteClient` used to simulate and await the receipt.
 * @param wc `SignerClient` (any viem `WalletClient` with an account) that signs and sends the transaction.
 * @param asset ERC-20 underlying asset to approve.
 * @param vault Morpho vault granted the allowance (the spender).
 * @param amount Allowance in raw asset units (asset decimals).
 * @returns The transaction hash.
 */
export async function approve(pc: WriteClient, wc: SignerClient, asset: Address, vault: Address, amount: bigint): Promise<{ hash: Hex }> {
  const { hash } = await sendSimulated(pc, wc, { address: asset, abi: erc20Abi, functionName: 'approve', args: [vault, amount] });
  return { hash };
}

/**
 * Deposits assets into the vault: simulates, sends, and waits for the receipt.
 * @param pc `WriteClient` used to simulate and await the receipt.
 * @param wc `SignerClient` (any viem `WalletClient` with an account) that signs and sends the transaction.
 * @param vault Morpho vault to deposit into.
 * @param assets Amount to deposit in raw asset units (asset decimals).
 * @param receiver Address credited with the minted shares.
 * @returns Transaction hash and shares minted, from the simulated return value.
 */
export async function deposit(pc: WriteClient, wc: SignerClient, vault: Address, assets: bigint, receiver: Address): Promise<{ hash: Hex; shares: bigint }> {
  const { hash, result } = await sendSimulated(pc, wc, { address: vault, abi: morphoVaultAbi, functionName: 'deposit', args: [assets, receiver] });
  return { hash, shares: result };
}

/**
 * Redeems an exact share amount from the vault: simulates, sends, and waits for
 * the receipt. Synchronous, but REVERTS when underlying market liquidity is
 * insufficient — surface that as "try a smaller amount or retry later".
 * @param pc `WriteClient` used to simulate and await the receipt.
 * @param wc `SignerClient` (any viem `WalletClient` with an account) that signs and sends the transaction.
 * @param vault Morpho vault to redeem from.
 * @param shares Amount of vault shares to redeem (share decimals).
 * @param receiver Address that receives the underlying assets.
 * @param owner Address whose shares are burned.
 * @returns Transaction hash and assets paid out, from the simulated return value.
 */
export async function redeem(pc: WriteClient, wc: SignerClient, vault: Address, shares: bigint, receiver: Address, owner: Address): Promise<{ hash: Hex; assets: bigint }> {
  const { hash, result } = await sendSimulated(pc, wc, { address: vault, abi: morphoVaultAbi, functionName: 'redeem', args: [shares, receiver, owner] });
  return { hash, assets: result };
}

/**
 * Withdraws an exact asset amount from the vault: simulates, sends, and waits
 * for the receipt. Reverts when underlying market liquidity is insufficient.
 * @param pc `WriteClient` used to simulate and await the receipt.
 * @param wc `SignerClient` (any viem `WalletClient` with an account) that signs and sends the transaction.
 * @param vault Morpho vault to withdraw from.
 * @param assets Amount to withdraw in raw asset units (asset decimals).
 * @param receiver Address that receives the underlying assets.
 * @param owner Address whose shares are burned.
 * @returns Transaction hash and shares burned, from the simulated return value.
 */
export async function withdraw(pc: WriteClient, wc: SignerClient, vault: Address, assets: bigint, receiver: Address, owner: Address): Promise<{ hash: Hex; shares: bigint }> {
  const { hash, result } = await sendSimulated(pc, wc, { address: vault, abi: morphoVaultAbi, functionName: 'withdraw', args: [assets, receiver, owner] });
  return { hash, shares: result };
}
