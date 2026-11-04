/** Read-only plan builders returning unsigned payloads in the shared envelope. */
import type { Address } from 'viem';
import { approveNeedsReset, orOnRevert, type Plan, type ReadClient } from '@sentora/vaults-plan';
import {
  getVaultMeta, getPosition, checkGates, previewDeposit, previewRedemption,
  getWithdrawalEpoch, getClaimable, type ClaimDate,
} from './core.js';
import { encodeApprove, encodeApproveReset, encodeApproveShares, encodeDeposit, encodeRequestRedeem, encodeInstantRedeem, encodeClaim } from './encode.js';

const FAMILY = 'upshift_evm';

export interface DepositParams {
  amount: bigint;
  owner: Address;
  receiver?: Address;
  /** any whitelisted asset; defaults to the vault's reference asset */
  assetIn?: Address;
}

/**
 * Read-only RPC preflight that builds an unsigned deposit plan: previews
 * shares, and checks pause state, sender/asset whitelists, per-tx max, deposit
 * cap, and balance.
 *
 * @param pc - `ReadClient` used for the read-only contract calls.
 * @param vault - Vault address.
 * @param params - Deposit parameters: amount, owner, optional receiver (defaults to owner), and optional assetIn (any whitelisted asset; defaults to the vault's reference asset).
 * @returns An unsigned `Plan` with `steps` (allowance reset/approve if needed, then deposit), `expected` (shares, amountInReferenceTokens), `blockers`, `warnings`, and `context` (assetIn, lpToken, symbols, decimals, sharePrice).
 */
export async function planDeposit(pc: ReadClient, vault: Address, params: DepositParams): Promise<Plan> {
  const { amount, owner, receiver = owner } = params;
  const meta = await getVaultMeta(pc, vault);
  const assetIn = params.assetIn ?? meta.asset;
  const [position, gates, preview, chainId] = await Promise.all([
    getPosition(pc, vault, assetIn, owner),
    checkGates(pc, vault, owner, assetIn),
    orOnRevert(previewDeposit(pc, vault, assetIn, amount), undefined),
    pc.getChainId(),
  ]);

  const plan: Plan = {
    family: FAMILY, action: 'deposit', vault, chainId,
    steps: [], expected: {}, blockers: [], warnings: [],
    context: {
      assetIn, lpToken: meta.lpToken,
      referenceAsset: meta.asset, assetSymbol: meta.assetSymbol, assetDecimals: meta.assetDecimals,
      shareSymbol: meta.shareSymbol, shareDecimals: meta.shareDecimals, sharePrice: meta.sharePrice.toString(),
    },
  };

  if (meta.depositsPaused) plan.blockers.push({ code: 'PAUSED', message: 'Deposits are paused' });
  if (!gates.canSend) {
    plan.blockers.push({ code: 'SENDER_NOT_WHITELISTED', message: `Senders whitelist denies ${owner}` });
  }
  if (!gates.assetAllowed || preview === undefined) {
    plan.blockers.push({ code: 'ASSET_NOT_ALLOWED', message: `Asset ${assetIn} is not accepted by the deposit path` });
  } else {
    plan.expected.shares = preview.shares.toString();
    plan.expected.amountInReferenceTokens = preview.amountInReferenceTokens.toString();
    if (preview.shares < 1n) {
      plan.blockers.push({
        code: 'AMOUNT_TOO_LOW',
        message: 'Deposit would mint zero shares',
        available: preview.shares.toString(), required: '1', decimals: meta.shareDecimals,
      });
    }
    if (preview.amountInReferenceTokens > meta.maxDepositAmount) {
      plan.blockers.push({
        code: 'MAX_DEPOSIT',
        message: `Deposit is ${preview.amountInReferenceTokens} reference units, per-tx max is ${meta.maxDepositAmount}`,
        available: meta.maxDepositAmount.toString(), required: preview.amountInReferenceTokens.toString(), decimals: meta.assetDecimals,
      });
    }
    if (preview.amountInReferenceTokens + meta.totalAssets > meta.depositCap) {
      plan.blockers.push({
        code: 'DEPOSIT_CAP',
        message: `Cap ${meta.depositCap} reached: vault holds ${meta.totalAssets}, deposit adds ${preview.amountInReferenceTokens}`,
        available: (meta.depositCap > meta.totalAssets ? meta.depositCap - meta.totalAssets : 0n).toString(),
        required: preview.amountInReferenceTokens.toString(),
        decimals: meta.assetDecimals,
      });
    }
  }
  if (position.assetBalance < amount) {
    plan.blockers.push({
      code: 'INSUFFICIENT_BALANCE',
      message: `Owner holds ${position.assetBalance} asset units, needs ${amount}`,
      available: position.assetBalance.toString(), required: amount.toString(),
      ...(assetIn.toLowerCase() === meta.asset.toLowerCase() ? { decimals: meta.assetDecimals } : {}),
    });
  }
  if (plan.blockers.length) return plan;

  if (position.allowance < amount) {
    const approve = encodeApprove(assetIn, vault, amount);
    if (position.allowance > 0n && await approveNeedsReset(pc, owner, approve)) plan.steps.push(encodeApproveReset(assetIn, vault));
    plan.steps.push(approve);
  }
  plan.steps.push(encodeDeposit(vault, assetIn, amount, receiver));
  return plan;
}

export interface RedeemParams {
  shares: bigint;
  owner: Address;
  receiver?: Address;
  /** true = instant redemption (fee, no queue); false = epoch queue */
  instant?: boolean;
}

/**
 * Read-only RPC preflight that builds an unsigned redemption plan, either
 * instant (fee, no queue, no share allowance) or via the epoch queue (share
 * approval + requestRedeem, assets claimable after the claim epoch). When the
 * vault has no timelock (lagDuration === 0) the queued path is blocked —
 * requestRedeem would revert; use instant redemption.
 *
 * @param pc - `ReadClient` used for the read-only contract calls.
 * @param vault - Vault address.
 * @param params - Redemption parameters: shares, owner, optional receiver (defaults to owner), and optional instant flag (true = instant redemption with fee, no queue; false = epoch queue, the default).
 * @returns An unsigned `Plan` with `steps` (share approval if needed, then requestRedeem or instantRedeem), `expected` (assets, assetsAfterFee), `blockers`, `warnings` (claim instructions for the queued path), and `context` (lpToken, symbols, decimals, fee, and claimDate/claimableEpoch for the queued path).
 */
export async function planRedeem(pc: ReadClient, vault: Address, params: RedeemParams): Promise<Plan> {
  const { shares, owner, receiver = owner, instant = false } = params;
  const meta = await getVaultMeta(pc, vault);
  const [position, gates, preview, chainId] = await Promise.all([
    getPosition(pc, vault, meta.asset, owner),
    checkGates(pc, vault, owner),
    previewRedemption(pc, vault, shares, instant),
    pc.getChainId(),
  ]);

  const plan: Plan = {
    family: FAMILY, action: instant ? 'instantRedeem' : 'requestRedeem', vault, chainId,
    steps: [],
    expected: { assets: preview.assetsAmount.toString(), assetsAfterFee: preview.assetsAfterFee.toString() },
    blockers: [], warnings: [],
    context: {
      lpToken: meta.lpToken, referenceAsset: meta.asset,
      assetSymbol: meta.assetSymbol, assetDecimals: meta.assetDecimals,
      shareSymbol: meta.shareSymbol, shareDecimals: meta.shareDecimals,
      fee: (instant ? meta.instantRedemptionFee : meta.withdrawalFee).toString(),
    },
  };

  if (meta.withdrawalsPaused) plan.blockers.push({ code: 'PAUSED', message: 'Withdrawals are paused' });
  if (!gates.canSend) {
    plan.blockers.push({ code: 'SENDER_NOT_WHITELISTED', message: `Senders whitelist denies ${owner}` });
  }
  if (position.shares < shares) {
    plan.blockers.push({
      code: 'INSUFFICIENT_SHARES',
      message: `Owner holds ${position.shares} shares, needs ${shares}`,
      available: position.shares.toString(), required: shares.toString(), decimals: meta.shareDecimals,
    });
  }
  if (preview.assetsAmount > meta.maxWithdrawalAmount) {
    plan.blockers.push({
      code: 'WITHDRAWAL_LIMIT',
      message: `Redemption is ${preview.assetsAmount} reference units, per-tx max is ${meta.maxWithdrawalAmount}`,
      available: meta.maxWithdrawalAmount.toString(), required: preview.assetsAmount.toString(), decimals: meta.assetDecimals,
    });
  }
  if (preview.assetsAfterFee < 1n) {
    plan.blockers.push({
      code: 'AMOUNT_TOO_LOW',
      message: 'Redemption nets zero assets after fees',
      available: preview.assetsAfterFee.toString(), required: '1', decimals: meta.assetDecimals,
    });
  }
  if (!instant && meta.lagDuration === 0n) {
    plan.blockers.push({ code: 'NOT_TIMELOCKED', message: 'Vault has no timelock — queued redemption reverts; use instant redemption' });
  }
  if (plan.blockers.length) return plan;

  if (instant) {
    plan.steps.push(encodeInstantRedeem(vault, shares, receiver));
  } else {
    const epoch = await getWithdrawalEpoch(pc, vault);
    plan.context.claimDate = { year: epoch.year, month: epoch.month, day: epoch.day };
    plan.context.claimableEpoch = epoch.claimableEpoch.toString();
    plan.warnings.push(
      `Assets are NOT received in this transaction: claim(${epoch.year}, ${epoch.month}, ${epoch.day}, receiver) after unix ${epoch.claimableEpoch} (see plan-claim).`,
    );
    if (position.shareAllowance < shares) plan.steps.push(encodeApproveShares(meta.lpToken, vault, shares));
    plan.steps.push(encodeRequestRedeem(vault, shares, receiver));
  }
  return plan;
}

export interface ClaimParams {
  date: ClaimDate;
  owner: Address;
  /** the receiver the redemption was requested FOR (claim pays this address); defaults to owner */
  receiver?: Address;
}

/**
 * Read-only RPC preflight that builds an unsigned claim plan for a queued
 * redemption: checks pause state, the senders whitelist, that shares are
 * queued for the receiver on that date, and that the execution epoch has
 * passed.
 *
 * @param pc - `ReadClient` used for the read-only contract calls.
 * @param vault - Vault address.
 * @param params - Claim parameters: date (the epoch date returned by the redemption request), owner, and optional receiver — the address the redemption was requested FOR (claim pays this address; defaults to owner).
 * @returns An unsigned `Plan` with `steps` (the claim call), `expected` (shares, assets, assetsAfterFee), `blockers`, `warnings`, and `context` (claimDate, receiver, symbols, decimals).
 */
export async function planClaim(pc: ReadClient, vault: Address, params: ClaimParams): Promise<Plan> {
  const { date, owner, receiver = owner } = params;
  const meta = await getVaultMeta(pc, vault);
  const [gates, claimable, now, chainId] = await Promise.all([
    checkGates(pc, vault, owner),
    getClaimable(pc, vault, date, receiver),
    pc.getBlock().then((b) => b.timestamp),
    pc.getChainId(),
  ]);

  const plan: Plan = {
    family: FAMILY, action: 'claim', vault, chainId,
    steps: [], expected: {}, blockers: [], warnings: [],
    context: {
      claimDate: date, receiver,
      shareSymbol: meta.shareSymbol, shareDecimals: meta.shareDecimals,
      assetSymbol: meta.assetSymbol, assetDecimals: meta.assetDecimals,
    },
  };

  if (meta.withdrawalsPaused) plan.blockers.push({ code: 'PAUSED', message: 'Withdrawals are paused' });
  if (!gates.canSend) {
    plan.blockers.push({ code: 'SENDER_NOT_WHITELISTED', message: `Senders whitelist denies ${owner}` });
  }
  if (claimable.shares === 0n) {
    plan.blockers.push({
      code: 'NOTHING_TO_CLAIM',
      message: `No queued shares for ${receiver} on ${date.year}-${date.month}-${date.day}`,
    });
  } else if (now < claimable.executionEpoch) {
    plan.blockers.push({
      code: 'TOO_EARLY',
      message: `Claimable after unix ${claimable.executionEpoch}, chain time is ${now}`,
    });
  }
  if (plan.blockers.length) return plan;

  const preview = await previewRedemption(pc, vault, claimable.shares, false);
  plan.expected.shares = claimable.shares.toString();
  plan.expected.assets = preview.assetsAmount.toString();
  plan.expected.assetsAfterFee = preview.assetsAfterFee.toString();
  plan.steps.push(encodeClaim(vault, date, receiver));
  return plan;
}
