/** Read-only plan builders returning unsigned payloads in the shared envelope. */
import { zeroAddress, type Address } from 'viem';
import { approveNeedsReset, orOnRevert, type Plan, type ReadClient } from '@sentora/vaults-plan';
import { boringVaultAbi, tellerAbi, boringQueueAbi, erc20Abi, rolesAuthorityAbi, QUEUE_REQUEST_WITHDRAW_SELECTOR } from './abi.js';
import {
  preflight, previewDepositShares, getPosition, isQueueDeprecated,
  getWithdrawAssetConfig, previewWithdrawAssets, type BoringVaultConfig,
} from './core.js';
import { encodeApproveAsset, encodeApproveAssetReset, encodeDeposit, encodeApproveSharesToQueue, encodeRequestWithdraw } from './encode.js';

const FAMILY = 'boring';

export interface BoringDepositParams {
  asset: Address;
  amount: bigint;
  owner: Address;
  /** haircut applied to the previewed shares for minimumMint (default 50 = 0.5%) */
  slippageBps?: number;
}

/**
 * Read-only RPC preflight that builds an unsigned deposit plan: previews the
 * shares, applies the slippage haircut for minimumMint, and checks pause
 * state, asset allowlist, roles, and balance. Shares mint to msg.sender —
 * the teller has no receiver parameter.
 *
 * @param pc - `ReadClient` used for the read-only contract calls.
 * @param cfg - Per-vault contract topology (vault, teller, accountant, queue, rolesAuthority).
 * @param params - Deposit parameters: asset, amount, owner, and optional slippageBps (default 50 = 0.5%, haircut applied to the previewed shares for minimumMint).
 * @returns An unsigned `Plan` with `steps` (allowance reset/approve if needed, then teller deposit), `expected` (shares, minimumMint), `blockers`, `warnings` (share re-lock), and `context` (decimals, sharePremiumBps, shareLockPeriodSeconds, teller variant).
 */
export async function planDeposit(pc: ReadClient, cfg: BoringVaultConfig, params: BoringDepositParams): Promise<Plan> {
  const { asset, amount, owner, slippageBps = 50 } = params;
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 9_999) {
    throw new Error(
      `@sentora/vaults-boring: slippageBps must be an integer in [0, 9999], got ${slippageBps} — 10000 or more would disable the minimumMint guard.`,
    );
  }
  const [pf, expectedShares, position, shareLockPeriod, shareDecimals, assetDecimals] = await Promise.all([
    preflight(pc, cfg, asset, owner),
    previewDepositShares(pc, cfg, asset, amount),
    getPosition(pc, cfg, asset, owner),
    orOnRevert(pc.readContract({ address: cfg.teller, abi: tellerAbi, functionName: 'shareLockPeriod' }), 0n),
    pc.readContract({ address: cfg.vault, abi: boringVaultAbi, functionName: 'decimals' }),
    pc.readContract({ address: asset, abi: erc20Abi, functionName: 'decimals' }),
  ]);

  const minimumMint = (expectedShares * (10_000n - BigInt(slippageBps))) / 10_000n;
  const plan: Plan = {
    family: FAMILY, action: 'deposit', vault: cfg.vault, chainId: cfg.chainId,
    steps: [], expected: { shares: expectedShares.toString(), minimumMint: minimumMint.toString() },
    blockers: [], warnings: [],
    context: {
      teller: cfg.teller, accountant: cfg.accountant, asset,
      assetDecimals, shareDecimals,
      sharePremiumBps: pf.sharePremiumBps, shareLockPeriodSeconds: shareLockPeriod.toString(),
      sharesMintedTo: 'msg.sender — the teller has no receiver parameter',
    },
  };

  if (pf.tellerPaused) plan.blockers.push({ code: 'PAUSED', message: 'Teller is paused' });
  if (!pf.assetAllowed) plan.blockers.push({ code: 'ASSET_NOT_ALLOWED', message: `Teller does not accept deposits in ${asset}` });
  if (!pf.canDeposit) {
    plan.blockers.push({ code: 'ROLE_DENIED', message: `RolesAuthority.canCall denies teller.deposit for ${owner}` });
  }
  if (position.assetBalance < amount) {
    plan.blockers.push({
      code: 'INSUFFICIENT_BALANCE',
      message: `Owner holds ${position.assetBalance} asset units, needs ${amount}`,
      available: position.assetBalance.toString(), required: amount.toString(), decimals: assetDecimals,
    });
  }
  if (plan.blockers.length) return plan;

  if (shareLockPeriod > 0n) {
    plan.warnings.push(
      `Deposit re-locks the ENTIRE share balance (address-wide) for ${shareLockPeriod}s — transfers and queue withdrawals revert until unlock.`,
    );
  }
  if (position.vaultAllowance < amount) {
    const approve = encodeApproveAsset(cfg, asset, amount);
    if (position.vaultAllowance > 0n && await approveNeedsReset(pc, owner, approve)) plan.steps.push(encodeApproveAssetReset(cfg, asset));
    plan.steps.push(approve);
  }
  plan.context.tellerDepositVariant = pf.tellerDepositVariant;
  plan.steps.push(encodeDeposit(cfg, asset, amount, minimumMint, pf.tellerDepositVariant));
  return plan;
}

export interface BoringWithdrawParams {
  assetOut: Address;
  shares: bigint;
  owner: Address;
  /** defaults to the queue's minimum discount for the asset */
  discountBps?: number;
  /** defaults to max(minimumSecondsToDeadline, 3 days) */
  secondsToDeadline?: number;
}

/**
 * Read-only RPC preflight that builds an unsigned withdrawal-request plan for
 * the async solver queue: validates discount/deadline bounds, queue pause
 * state, minimums, share balance, and the share lock. The receipt's
 * OnChainWithdrawRequested event struct must be persisted — cancel/replace
 * require the full 8-field tuple.
 *
 * @param pc - `ReadClient` used for the read-only contract calls.
 * @param cfg - Per-vault contract topology; a configured `queue` is required.
 * @param params - Withdrawal parameters: assetOut, shares, owner, optional discountBps (defaults to the queue's minimum discount for the asset, uint16) and secondsToDeadline (defaults to max(minimumSecondsToDeadline, 3 days), uint24).
 * @returns An unsigned `Plan` with `steps` (share approval to the queue if needed, then requestOnChainWithdraw), `expected.assets`, `blockers`, `warnings` (persist the event struct), and `context` (queue, decimals, discountBps, deadlines, maturity).
 */
export async function planRequestWithdraw(pc: ReadClient, cfg: BoringVaultConfig, params: BoringWithdrawParams): Promise<Plan> {
  const { assetOut, shares, owner } = params;
  if (params.secondsToDeadline !== undefined && (!Number.isInteger(params.secondsToDeadline) || params.secondsToDeadline < 0 || params.secondsToDeadline > 16_777_215)) {
    throw new Error(`@sentora/vaults-boring: secondsToDeadline must be an integer in [0, 16777215] (uint24), got ${params.secondsToDeadline}.`);
  }
  if (params.discountBps !== undefined && (!Number.isInteger(params.discountBps) || params.discountBps < 0 || params.discountBps > 65_535)) {
    throw new Error(`@sentora/vaults-boring: discountBps must be an integer in [0, 65535] (uint16), got ${params.discountBps}.`);
  }

  const plan: Plan = {
    family: FAMILY, action: 'requestWithdraw', vault: cfg.vault, chainId: cfg.chainId,
    steps: [], expected: {}, blockers: [], warnings: [],
    context: { queue: cfg.queue, assetOut },
  };

  if (!cfg.queue || cfg.queue === zeroAddress) {
    plan.blockers.push({ code: 'QUEUE_UNKNOWN', message: 'No BoringOnChainQueue configured — rerun discovery with an explicit queue address' });
    return plan;
  }

  const [wcfg, position, queuePaused, canRequest, unlock, shareDecimals, assetDecimals] = await Promise.all([
    getWithdrawAssetConfig(pc, cfg, assetOut),
    getPosition(pc, cfg, assetOut, owner),
    // no revert fallback (unlike shareUnlockTime): an unreadable pause state must fail the plan, not read as unpaused
    pc.readContract({ address: cfg.queue, abi: boringQueueAbi, functionName: 'isPaused' }),
    pc.readContract({ address: cfg.rolesAuthority, abi: rolesAuthorityAbi, functionName: 'canCall', args: [owner, cfg.queue, QUEUE_REQUEST_WITHDRAW_SELECTOR] }),
    orOnRevert(pc.readContract({ address: cfg.teller, abi: tellerAbi, functionName: 'shareUnlockTime', args: [owner] }), 0n),
    pc.readContract({ address: cfg.vault, abi: boringVaultAbi, functionName: 'decimals' }),
    pc.readContract({ address: assetOut, abi: erc20Abi, functionName: 'decimals' }),
  ]);

  plan.context.assetDecimals = assetDecimals;
  plan.context.shareDecimals = shareDecimals;
  const discountBps = params.discountBps ?? wcfg.minDiscountBps;
  const secondsToDeadline = params.secondsToDeadline ?? Math.max(wcfg.minimumSecondsToDeadline, 3 * 24 * 3600);

  // permission blockers before PAUSED: integrations often surface only blockers[0], and QUEUE_DEPRECATED says what to do
  if (!canRequest) {
    const deprecated = await orOnRevert(isQueueDeprecated(pc, cfg.rolesAuthority, cfg.queue), false);
    plan.blockers.push(deprecated
      ? { code: 'QUEUE_DEPRECATED', message: `Queue ${cfg.queue} no longer accepts withdrawal requests — use the vault's current queue` }
      : { code: 'ROLE_DENIED', message: `RolesAuthority.canCall denies queue.requestOnChainWithdraw for ${owner}` });
  }
  if (queuePaused) plan.blockers.push({ code: 'PAUSED', message: 'Queue is paused' });
  if (!wcfg.allowWithdraws) plan.blockers.push({ code: 'ASSET_NOT_ALLOWED', message: `Queue does not allow withdrawals in ${assetOut}` });
  if (shares < wcfg.minimumShares) {
    plan.blockers.push({
      code: 'BELOW_MINIMUM',
      message: `Queue minimum is ${wcfg.minimumShares} shares, requested ${shares}`,
      available: shares.toString(), required: wcfg.minimumShares.toString(), decimals: shareDecimals,
    });
  }
  if (discountBps < wcfg.minDiscountBps || discountBps > wcfg.maxDiscountBps) {
    plan.blockers.push({
      code: 'DISCOUNT_OUT_OF_RANGE',
      message: `Discount ${discountBps} bps outside [${wcfg.minDiscountBps}, ${wcfg.maxDiscountBps}]`,
    });
  }
  if (position.shares < shares) {
    plan.blockers.push({
      code: 'INSUFFICIENT_SHARES',
      message: `Owner holds ${position.shares} shares, needs ${shares}`,
      available: position.shares.toString(), required: shares.toString(), decimals: shareDecimals,
    });
  }
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (unlock > now) {
    plan.blockers.push({ code: 'SHARES_LOCKED', message: `Shares locked until unix ${unlock} — the queue cannot escrow them yet` });
  }
  if (plan.blockers.length) return plan;

  plan.expected.assets = (await previewWithdrawAssets(pc, cfg, assetOut, shares, discountBps)).toString();
  plan.context.discountBps = discountBps;
  plan.context.secondsToDeadline = secondsToDeadline;
  plan.context.secondsToMaturity = wcfg.secondsToMaturity;
  plan.warnings.push(
    'Async solver queue: assets arrive when a solver fills the request after maturity. Persist the OnChainWithdrawRequested event struct from the receipt — cancel/replace require the full 8-field tuple.',
  );

  if (position.queueShareAllowance < shares) plan.steps.push(encodeApproveSharesToQueue(cfg, shares));
  plan.steps.push(encodeRequestWithdraw(cfg, assetOut, shares, discountBps, secondsToDeadline));
  return plan;
}

/**
 * Reads the owner's asset allowance toward the vault. Kept for callers that
 * need a bare allowance read without the full position.
 *
 * @param pc - `ReadClient` used for the read.
 * @param cfg - Per-vault contract topology; `cfg.vault` is the spender.
 * @param asset - ERC-20 asset whose allowance is read.
 * @param owner - Allowance owner address.
 * @returns The allowance in the asset's smallest units.
 */
export async function readAssetAllowance(pc: ReadClient, cfg: BoringVaultConfig, asset: Address, owner: Address): Promise<bigint> {
  return pc.readContract({ address: asset, abi: erc20Abi, functionName: 'allowance', args: [owner, cfg.vault] });
}
