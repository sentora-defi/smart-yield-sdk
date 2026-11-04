import * as boring from '@sentora/vaults-boring';
import type { PublicClient } from 'viem';
import { humanOpt, makeClient, requireAddress, requireAmount, optionalAddress, optionalBigInt, optionalInt } from '../helpers';
import { ms, vlog } from '../verbose';
import type { CommandDef, Flags, OptSpec } from '../types';

const vault: OptSpec = { type: 'string', required: true, placeholder: '<address>', description: 'BoringVault (share token) address.' };
const owner: OptSpec = { type: 'string', required: true, placeholder: '<address>', description: 'Account that holds/sends the funds.' };
const teller: OptSpec = { type: 'string', placeholder: '<address>', description: 'Teller address (skips deriving it from the vault hook).' };
const queue: OptSpec = {
  type: 'string',
  placeholder: '<address>',
  description: 'BoringOnChainQueue address. Omitting it triggers a full-range event scan on the authority — slow or capped on public RPCs.',
};
const fromBlock: OptSpec = { type: 'string', placeholder: '<block>', description: 'Start block for the queue event scan (default 0).' };

async function loadConfig(pc: PublicClient, flags: Flags): Promise<boring.DiscoveredConfig> {
  const queueFlag = optionalAddress(flags, 'queue');
  const fromBlock = optionalBigInt(flags, 'from-block');
  vlog(
    queueFlag
      ? 'boring discovery: queue provided — point reads only'
      : `boring discovery: queue unknown — authority event scan from block ${fromBlock ?? 0n} (bound it with --from-block on public RPCs)`,
  );
  const started = performance.now();
  const d = await boring.discoverConfig(pc, requireAddress(flags, 'vault'), {
    teller: optionalAddress(flags, 'teller'),
    queue: queueFlag,
    fromBlock,
  });
  vlog(
    `boring discovery: teller=${d.config.teller} accountant=${d.config.accountant} ` +
    `queue=${d.queueUnknown ? '(not found)' : d.config.queue} authority=${d.config.rolesAuthority} in ${ms(started)}`,
  );
  return d;
}

export const boringCommands: CommandDef[] = [
  {
    family: 'boring',
    name: 'discover',
    summary: 'Derive the vault topology (teller, accountant, queue, authority) from the vault address alone.',
    options: { vault, teller, queue, 'from-block': fromBlock },
    examples: ['smart-yield boring discover --vault 0xVAULT --rpc-url $RPC'],
    run: async (flags) => loadConfig(makeClient(flags), flags),
  },
  {
    family: 'boring',
    name: 'position',
    summary: 'Owner position priced via the accountant rate, plus both allowances (asset→vault, shares→queue).',
    options: {
      vault,
      owner,
      asset: { type: 'string', required: true, placeholder: '<address>', description: 'Quote/deposit asset address.' },
      teller,
      queue,
      'from-block': fromBlock,
    },
    examples: ['smart-yield boring position --vault 0xVAULT --asset 0xUSDC --owner 0xOWNER --queue 0xQUEUE --rpc-url $RPC'],
    run: async (flags) => {
      const pc = makeClient(flags);
      const { config, warnings } = await loadConfig(pc, flags);
      const o = requireAddress(flags, 'owner');
      const asset = requireAddress(flags, 'asset');
      const position = await boring.getPosition(pc, config, asset, o);
      return { vault: config.vault, owner: o, asset, ...position, config, warnings };
    },
  },
  {
    family: 'boring',
    name: 'plan-deposit',
    summary: 'Unsigned teller deposit plan with minimumMint slippage guard. Shares mint to msg.sender (no receiver).',
    options: {
      vault,
      owner,
      asset: { type: 'string', required: true, placeholder: '<address>', description: 'Deposit asset address.' },
      amount: { type: 'string', required: true, placeholder: '<amount>', description: 'Deposit amount in asset units (base units, or decimal with --human).' },
      'slippage-bps': { type: 'string', placeholder: '<bps>', description: 'Haircut on previewed shares for minimumMint (default 50 = 0.5%).' },
      human: humanOpt,
      teller,
      queue,
      'from-block': fromBlock,
    },
    examples: ['smart-yield boring plan-deposit --vault 0xVAULT --asset 0xUSDC --amount 1000000 --owner 0xOWNER --rpc-url $RPC'],
    run: async (flags) => {
      const pc = makeClient(flags);
      const asset = requireAddress(flags, 'asset');
      const owner = requireAddress(flags, 'owner');
      // at 10000 bps the minimumMint guard becomes 0; bounded here, before discovery hits the network
      const slippageBps = optionalInt(flags, 'slippage-bps', 9_999);
      const { config, warnings } = await loadConfig(pc, flags);
      const plan = await boring.planDeposit(pc, config, {
        asset,
        amount: await requireAmount(pc, flags, 'amount', asset),
        owner,
        slippageBps,
      });
      plan.warnings.push(...warnings);
      plan.context.discovered = config;
      return plan;
    },
  },
  {
    family: 'boring',
    name: 'plan-withdraw',
    summary: 'Unsigned async queue withdrawal plan (approve shares to queue + requestOnChainWithdraw).',
    options: {
      vault,
      owner,
      'asset-out': { type: 'string', required: true, placeholder: '<address>', description: 'Asset to receive.' },
      shares: { type: 'string', required: true, placeholder: '<amount>', description: 'Shares to queue (base units, or decimal with --human).' },
      'discount-bps': { type: 'string', placeholder: '<bps>', description: "Solver discount (default: the queue's minimum for the asset)." },
      'seconds-to-deadline': { type: 'string', placeholder: '<s>', description: 'Request validity window (default: max(queue minimum, 3 days)).' },
      human: humanOpt,
      teller,
      queue,
      'from-block': fromBlock,
    },
    examples: [
      'smart-yield boring plan-withdraw --vault 0xVAULT --asset-out 0xUSDC --shares 1000000 --owner 0xOWNER --queue 0xQUEUE --rpc-url $RPC',
    ],
    run: async (flags) => {
      const pc = makeClient(flags);
      const vaultAddr = requireAddress(flags, 'vault');
      const assetOut = requireAddress(flags, 'asset-out');
      const owner = requireAddress(flags, 'owner');
      const discountBps = optionalInt(flags, 'discount-bps', 65_535); // uint16 ABI slot; queue min/max enforced in the plan
      const secondsToDeadline = optionalInt(flags, 'seconds-to-deadline', 16_777_215); // uint24 ABI slot
      const { config, warnings } = await loadConfig(pc, flags);
      const plan = await boring.planRequestWithdraw(pc, config, {
        assetOut,
        shares: await requireAmount(pc, flags, 'shares', vaultAddr),
        owner,
        discountBps,
        secondsToDeadline,
      });
      plan.warnings.push(...warnings);
      plan.context.discovered = config;
      return plan;
    },
  },
];
