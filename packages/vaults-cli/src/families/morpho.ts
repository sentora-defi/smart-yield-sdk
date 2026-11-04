import * as morpho from '@sentora/vaults-morpho';
import { erc4626Asset, humanOpt, makeClient, requireAddress, requireAmount, optionalAddress } from '../helpers';
import type { CommandDef, OptSpec } from '../types';

const vault: OptSpec = { type: 'string', required: true, placeholder: '<address>', description: 'Morpho vault address (V1 MetaMorpho or V2).' };
const owner: OptSpec = { type: 'string', required: true, placeholder: '<address>', description: 'Account that holds/sends the funds.' };
const receiver: OptSpec = { type: 'string', placeholder: '<address>', description: 'Receiver (defaults to --owner).' };

export const morphoCommands: CommandDef[] = [
  {
    family: 'morpho',
    name: 'meta',
    summary: 'Vault metadata incl. isV2 (V2 detected via gate getters).',
    options: { vault },
    examples: ['smart-yield morpho meta --vault 0xVAULT --rpc-url $RPC'],
    run: async (flags) => morpho.getVaultMeta(makeClient(flags), requireAddress(flags, 'vault')),
  },
  {
    family: 'morpho',
    name: 'position',
    summary: 'Owner position. NOTE: maxWithdrawRaw is ALWAYS 0 on V2 by design — not a capacity signal.',
    options: {
      vault,
      owner,
      asset: { type: 'string', placeholder: '<address>', description: 'Underlying asset (skips a meta lookup when provided).' },
    },
    examples: ['smart-yield morpho position --vault 0xVAULT --owner 0xOWNER --rpc-url $RPC'],
    run: async (flags) => {
      const pc = makeClient(flags);
      const v = requireAddress(flags, 'vault');
      const o = requireAddress(flags, 'owner');
      const asset = optionalAddress(flags, 'asset') ?? (await morpho.getVaultMeta(pc, v)).asset;
      const position = await morpho.getPosition(pc, v, asset, o);
      return { vault: v, owner: o, asset, ...position };
    },
  },
  {
    family: 'morpho',
    name: 'gates',
    summary: 'V2 gate preflight: canDeposit / canWithdraw eligibility for a user (always true on V1).',
    options: { vault, owner },
    examples: ['smart-yield morpho gates --vault 0xVAULT --owner 0xOWNER --rpc-url $RPC'],
    run: async (flags) => {
      const v = requireAddress(flags, 'vault');
      const o = requireAddress(flags, 'owner');
      const gates = await morpho.checkGates(makeClient(flags), v, o);
      return { vault: v, user: o, ...gates };
    },
  },
  {
    family: 'morpho',
    name: 'plan-deposit',
    summary: 'Unsigned deposit plan (gate-checked; approve if needed + deposit). Non-empty blockers ⇒ do not execute.',
    options: {
      vault,
      owner,
      receiver,
      assets: { type: 'string', required: true, placeholder: '<amount>', description: 'Deposit amount in asset units (base units, or decimal with --human).' },
      human: humanOpt,
    },
    examples: ['smart-yield morpho plan-deposit --vault 0xVAULT --assets 1000000 --owner 0xOWNER --rpc-url $RPC'],
    run: async (flags) => {
      const pc = makeClient(flags);
      const v = requireAddress(flags, 'vault');
      return morpho.planDeposit(pc, v, {
        assets: await requireAmount(pc, flags, 'assets', () => erc4626Asset(pc, v)),
        owner: requireAddress(flags, 'owner'),
        receiver: optionalAddress(flags, 'receiver'),
      });
    },
  },
  {
    family: 'morpho',
    name: 'plan-redeem',
    summary: 'Unsigned redeem-by-shares plan. Synchronous but reverts on insufficient market liquidity.',
    options: {
      vault,
      owner,
      receiver,
      shares: { type: 'string', required: true, placeholder: '<amount>', description: 'Shares to redeem (base units, or decimal with --human).' },
      human: humanOpt,
    },
    examples: ['smart-yield morpho plan-redeem --vault 0xVAULT --shares 1000000 --owner 0xOWNER --rpc-url $RPC'],
    run: async (flags) => {
      const pc = makeClient(flags);
      const v = requireAddress(flags, 'vault');
      return morpho.planRedeem(pc, v, {
        shares: await requireAmount(pc, flags, 'shares', v),
        owner: requireAddress(flags, 'owner'),
        receiver: optionalAddress(flags, 'receiver'),
      });
    },
  },
];
