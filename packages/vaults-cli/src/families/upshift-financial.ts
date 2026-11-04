import * as uf from '@sentora/vaults-upshift-financial';
import type { Address, PublicClient } from 'viem';
import { CliError, toCliError } from '../errors';
import { erc4626Asset, humanOpt, makeClient, requireAddress, requireAmount, requireString, optionalAddress, shown } from '../helpers';
import type { CommandDef, Flags, OptSpec } from '../types';
import { baseOpts as yieldsBaseOpts, client as yieldsClient } from './yields';

const vault: OptSpec = {
  type: 'string',
  required: true,
  placeholder: '<address>',
  description: "Upshift Financial TokenizedVault address (the API `contracts.vault`, NOT `contracts.receiptToken`); discover via 'smart-yield yields list --family upshift_evm'.",
};
const owner: OptSpec = { type: 'string', required: true, placeholder: '<address>', description: 'Account that holds/sends the funds.' };
const receiver: OptSpec = { type: 'string', placeholder: '<address>', description: 'Receiver (defaults to --owner).' };

function claimDate(flags: Flags): uf.ClaimDate {
  const parse = (name: string, min: number, max: number) => {
    const v = requireString(flags, name);
    const n = Number(v);
    if (!/^\d+$/.test(v) || n < min || n > max) {
      throw new CliError('USAGE', `--${name} must be an integer in [${min}, ${max}], got '${shown(v)}'.`);
    }
    return n;
  };
  return { year: parse('year', 2024, 2100), month: parse('month', 1, 12), day: parse('day', 1, 31) };
}

export const upshiftFinancialCommands: CommandDef[] = [
  {
    family: 'upshift_evm',
    name: 'meta',
    summary: 'Vault metadata: LP token, symbols, decimals, share price, caps, fees, pause flags, timelock.',
    options: { vault },
    examples: ['smart-yield upshift_evm meta --vault 0xVAULT --rpc-url $RPC'],
    run: async (flags) => uf.getVaultMeta(makeClient(flags), requireAddress(flags, 'vault')),
  },
  {
    family: 'upshift_evm',
    name: 'position',
    summary: 'Owner position: LP shares, value before fees, balance, plus BOTH allowances (asset→vault, shares→vault).',
    options: {
      vault,
      owner,
      asset: { type: 'string', placeholder: '<address>', description: 'Deposit asset (defaults to the reference asset).' },
    },
    examples: ['smart-yield upshift_evm position --vault 0xVAULT --owner 0xOWNER --rpc-url $RPC'],
    run: async (flags) => {
      const pc = makeClient(flags);
      const v = requireAddress(flags, 'vault');
      const o = requireAddress(flags, 'owner');
      const asset = optionalAddress(flags, 'asset') ?? (await erc4626Asset(pc, v));
      const position = await uf.getPosition(pc, v, asset, o);
      return { vault: v, owner: o, asset, ...position };
    },
  },
  {
    family: 'upshift_evm',
    name: 'gates',
    summary: 'Whitelist preflight: can this sender interact, is this asset depositable.',
    options: {
      vault,
      owner,
      asset: { type: 'string', placeholder: '<address>', description: 'Deposit asset to check (defaults to the reference asset).' },
    },
    examples: ['smart-yield upshift_evm gates --vault 0xVAULT --owner 0xOWNER --rpc-url $RPC'],
    run: async (flags) => {
      const v = requireAddress(flags, 'vault');
      const o = requireAddress(flags, 'owner');
      const gates = await uf.checkGates(makeClient(flags), v, o, optionalAddress(flags, 'asset'));
      return { vault: v, user: o, ...gates };
    },
  },
  {
    family: 'upshift_evm',
    name: 'plan-deposit',
    summary: 'Unsigned deposit plan (approve if needed + deposit). Caps checked in reference-asset units.',
    options: {
      vault,
      owner,
      receiver,
      amount: { type: 'string', required: true, placeholder: '<amount>', description: 'Deposit amount in asset units (base units, or decimal with --human).' },
      asset: { type: 'string', placeholder: '<address>', description: 'Deposit asset (defaults to the reference asset; must be whitelisted).' },
      human: humanOpt,
    },
    examples: [
      'smart-yield upshift_evm plan-deposit --vault 0xVAULT --amount 1000000 --owner 0xOWNER --rpc-url $RPC',
      'smart-yield upshift_evm plan-deposit --vault 0xVAULT --amount 100.5 --human --owner 0xOWNER --rpc-url $RPC',
    ],
    run: async (flags) => {
      const pc = makeClient(flags);
      const v = requireAddress(flags, 'vault');
      const assetIn = optionalAddress(flags, 'asset');
      return uf.planDeposit(pc, v, {
        amount: await requireAmount(pc, flags, 'amount', assetIn ?? (() => erc4626Asset(pc, v))),
        owner: requireAddress(flags, 'owner'),
        receiver: optionalAddress(flags, 'receiver'),
        assetIn,
      });
    },
  },
  {
    family: 'upshift_evm',
    name: 'plan-redeem',
    summary: 'Unsigned redeem plan: epoch queue by default (approve shares + requestRedeem), or --instant (burn, fee).',
    options: {
      vault,
      owner,
      receiver,
      shares: { type: 'string', required: true, placeholder: '<amount>', description: 'LP shares to redeem (base units, or decimal with --human).' },
      instant: { type: 'boolean', description: 'Instant redemption (fee applies) instead of the epoch queue.' },
      human: humanOpt,
    },
    examples: [
      'smart-yield upshift_evm plan-redeem --vault 0xVAULT --shares 1000000 --owner 0xOWNER --rpc-url $RPC',
      'smart-yield upshift_evm plan-redeem --vault 0xVAULT --shares 1000000 --owner 0xOWNER --instant --rpc-url $RPC',
    ],
    run: async (flags) => {
      const pc = makeClient(flags);
      const v = requireAddress(flags, 'vault');
      const lpToken = () => pc.readContract({ address: v, abi: uf.tokenizedVaultAbi, functionName: 'lpTokenAddress' });
      return uf.planRedeem(pc, v, {
        shares: await requireAmount(pc, flags, 'shares', lpToken),
        owner: requireAddress(flags, 'owner'),
        receiver: optionalAddress(flags, 'receiver'),
        instant: flags.instant === true,
      });
    },
  },
  {
    family: 'upshift_evm',
    name: 'plan-claim',
    summary: 'Unsigned claim plan for a matured queued redemption (date comes from the requestRedeem plan/receipt).',
    options: {
      vault,
      owner,
      receiver: { type: 'string', placeholder: '<address>', description: 'Receiver the redemption was requested FOR (defaults to --owner).' },
      year: { type: 'string', required: true, placeholder: '<yyyy>', description: 'Claim date year (from requestRedeem).' },
      month: { type: 'string', required: true, placeholder: '<m>', description: 'Claim date month.' },
      day: { type: 'string', required: true, placeholder: '<d>', description: 'Claim date day.' },
    },
    examples: ['smart-yield upshift_evm plan-claim --vault 0xVAULT --year 2026 --month 8 --day 30 --owner 0xOWNER --rpc-url $RPC'],
    run: async (flags) =>
      uf.planClaim(makeClient(flags), requireAddress(flags, 'vault'), {
        date: claimDate(flags),
        owner: requireAddress(flags, 'owner'),
        receiver: optionalAddress(flags, 'receiver'),
      }),
  },
  {
    family: 'upshift_evm',
    name: 'epoch',
    summary: 'The (year, month, day, claimableEpoch) a redemption requested right now would land on.',
    options: { vault },
    examples: ['smart-yield upshift_evm epoch --vault 0xVAULT --rpc-url $RPC'],
    run: async (flags) => uf.getWithdrawalEpoch(makeClient(flags), requireAddress(flags, 'vault')),
  },
  {
    family: 'upshift_evm',
    name: 'pending-withdrawals',
    summary: 'Queued redemptions not paid out yet, however old: request times from the yields API activity, unpaid shares and claim dates from the vault.',
    options: {
      vault,
      owner: { type: 'string', required: true, placeholder: '<address>', description: 'Account that called requestRedeem (the API indexes requests under it).' },
      receiver: { type: 'string', placeholder: '<address>', description: 'Receiver the redemptions were requested for (defaults to --owner).' },
      ...yieldsBaseOpts,
    },
    examples: ['smart-yield upshift_evm pending-withdrawals --vault 0xVAULT --owner 0xOWNER --rpc-url $RPC'],
    run: async (flags) => {
      const api = yieldsClient(flags);
      const pc = makeClient(flags);
      const v = requireAddress(flags, 'vault');
      const o = requireAddress(flags, 'owner');
      const r = optionalAddress(flags, 'receiver') ?? o;
      const chainId = String(await pc.getChainId());
      const activity: unknown = await api.getUserVaultActivity(chainId, v, o);
      // the API answers [] for a chain or vault it doesn't index; getVault 404s there instead
      if (Array.isArray(activity) && activity.length === 0) await api.getVault(chainId, v);
      return {
        vault: v,
        owner: o,
        receiver: r,
        ...(await pendingWithdrawalsReport(pc, v, r, activity)),
        notice: 'Requests are read from the yields API, which indexes them a few minutes after they are mined.',
      };
    },
  },
];

const MAX_LISTED_BLOCKS = 5;

export async function pendingWithdrawalsReport(pc: PublicClient, vault: Address, receiver: Address, activity: unknown) {
  const { withdrawals, requestCount, historicReadErrors } = await uf.getPendingWithdrawalsFromActivity(pc, vault, receiver, activity).catch((e) => {
    throw e instanceof uf.InvalidActivityError ? new CliError('UPSTREAM_API', e.message) : e;
  });
  const [first] = historicReadErrors;
  const blocks = historicReadErrors.map((e) => e.blockNumber);
  const listed = blocks.length > MAX_LISTED_BLOCKS
    ? `${blocks.slice(0, MAX_LISTED_BLOCKS).join(', ')} and ${blocks.length - MAX_LISTED_BLOCKS} more`
    : blocks.join(', ');
  return {
    requestsByOwner: requestCount,
    pending: withdrawals,
    warnings: first
      ? [`Could not read the vault at block(s) ${listed} (${toCliError(first.cause).message}); requests mined there are dated with the current lagDuration, which is wrong only if the vault owner changed it after they were mined. An archive RPC removes this assumption.`]
      : [],
  };
}
