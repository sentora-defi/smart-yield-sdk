/** Read-only plan builders returning unsigned payloads in the shared envelope. */
import type { Address } from 'viem';
import { approveNeedsReset, type Plan, type ReadClient } from '@sentora/vaults-plan';
import { getVaultMeta, getPosition, checkGates, previewDeposit, previewRedeem } from './core.js';
import { encodeApprove, encodeApproveReset, encodeDeposit, encodeRedeem } from './encode.js';

const FAMILY = 'morpho';

export interface MorphoDepositParams {
  assets: bigint;
  owner: Address;
  receiver?: Address;
}

/**
 * Read-only RPC preflight for a Morpho vault deposit. Checks V2 gate eligibility
 * and owner balance, then assembles the unsigned steps (approveReset/approve
 * when the current allowance is insufficient, plus deposit). On V2 it
 * warns that max* getters always return 0 by design — do not derive capacity from them.
 * @param pc `ReadClient` used for the read-only RPC calls.
 * @param vault Morpho vault (V1 MetaMorpho or V2) to deposit into.
 * @param params Deposit amount, owner, and optional receiver (defaults to owner).
 * @returns Unsigned Plan: steps, expected shares, blockers, warnings, and vault context including version and gating (no signing or broadcasting).
 */
export async function planDeposit(pc: ReadClient, vault: Address, params: MorphoDepositParams): Promise<Plan> {
  const { assets, owner, receiver = owner } = params;
  const meta = await getVaultMeta(pc, vault);
  const [position, gates, expectedShares, chainId] = await Promise.all([
    getPosition(pc, vault, meta.asset, owner),
    checkGates(pc, vault, owner),
    previewDeposit(pc, vault, assets),
    pc.getChainId(),
  ]);

  const plan: Plan = {
    family: FAMILY, action: 'deposit', vault, chainId,
    steps: [], expected: { shares: expectedShares.toString() },
    blockers: [], warnings: [],
    context: {
      asset: meta.asset, assetSymbol: meta.assetSymbol, assetDecimals: meta.assetDecimals,
      shareSymbol: meta.shareSymbol, shareDecimals: meta.shareDecimals,
      version: meta.isV2 ? 'v2' : 'v1', gated: gates.gated,
    },
  };

  if (!gates.canDeposit) {
    plan.blockers.push({
      code: 'GATE_DENIED',
      message: `V2 gates deny deposits for ${owner} (receiveShares/sendAssets gate check failed)`,
    });
  }
  if (position.assetBalance < assets) {
    plan.blockers.push({
      code: 'INSUFFICIENT_BALANCE',
      message: `Owner holds ${position.assetBalance} ${meta.assetSymbol} units, needs ${assets}`,
      available: position.assetBalance.toString(), required: assets.toString(), decimals: meta.assetDecimals,
    });
  }
  if (plan.blockers.length) return plan;

  if (meta.isV2) {
    plan.warnings.push('Morpho V2: max* getters always return 0 by design — do not derive capacity from them.');
  }
  if (position.allowance < assets) {
    const approve = encodeApprove(meta.asset, vault, assets);
    if (position.allowance > 0n && await approveNeedsReset(pc, owner, approve)) plan.steps.push(encodeApproveReset(meta.asset, vault));
    plan.steps.push(approve);
  }
  plan.steps.push(encodeDeposit(vault, assets, receiver));
  return plan;
}

export interface MorphoRedeemParams {
  shares: bigint;
  owner: Address;
  receiver?: Address;
}

/**
 * Read-only RPC preflight for a Morpho vault redemption. Checks V2 gate
 * eligibility and share balance, then assembles the unsigned redeem step with a
 * warning that redemption is synchronous but reverts when underlying market
 * liquidity is insufficient (try a smaller amount or retry later).
 * @param pc `ReadClient` used for the read-only RPC calls.
 * @param vault Morpho vault (V1 MetaMorpho or V2) to redeem from.
 * @param params Shares to redeem, owner, and optional receiver (defaults to owner).
 * @returns Unsigned Plan: steps, expected assets, blockers, warnings, and vault context including version (no signing or broadcasting).
 */
export async function planRedeem(pc: ReadClient, vault: Address, params: MorphoRedeemParams): Promise<Plan> {
  const { shares, owner, receiver = owner } = params;
  const meta = await getVaultMeta(pc, vault);
  const [position, gates, chainId] = await Promise.all([
    getPosition(pc, vault, meta.asset, owner),
    checkGates(pc, vault, owner),
    pc.getChainId(),
  ]);

  const plan: Plan = {
    family: FAMILY, action: 'redeem', vault, chainId,
    steps: [], expected: {}, blockers: [], warnings: [],
    context: {
      asset: meta.asset, assetSymbol: meta.assetSymbol, assetDecimals: meta.assetDecimals,
      shareSymbol: meta.shareSymbol, shareDecimals: meta.shareDecimals,
      version: meta.isV2 ? 'v2' : 'v1',
    },
  };

  if (!gates.canWithdraw) {
    plan.blockers.push({
      code: 'GATE_DENIED',
      message: `V2 gates deny withdrawals for ${owner} (sendShares/receiveAssets gate check failed)`,
    });
  }
  if (position.shares < shares) {
    plan.blockers.push({
      code: 'INSUFFICIENT_SHARES',
      message: `Owner holds ${position.shares} shares, needs ${shares}`,
      available: position.shares.toString(), required: shares.toString(), decimals: meta.shareDecimals,
    });
  }
  if (plan.blockers.length) return plan;

  plan.expected.assets = (await previewRedeem(pc, vault, shares)).toString();
  plan.warnings.push('Synchronous, but REVERTS when underlying market liquidity is insufficient — on revert, try a smaller amount or retry later.');
  plan.steps.push(encodeRedeem(vault, shares, receiver, owner));
  return plan;
}
