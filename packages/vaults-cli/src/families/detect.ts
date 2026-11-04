import { parseAbi, type Address, type PublicClient } from 'viem';
import { isContractRevert } from '@sentora/vaults-plan';
import { CliError, isRpcShapedError } from '../errors';
import { makeClient, requireAddress } from '../helpers';
import type { CommandDef } from '../types';

export type Family = 'morpho' | 'boring' | 'upshift_evm';

const probeAbi = parseAbi([
  'function asset() view returns (address)',
  'function MORPHO() view returns (address)',
  'function receiveSharesGate() view returns (address)',
  'function lpTokenAddress() view returns (address)',
  'function hook() view returns (address)',
]);

async function probes(pc: PublicClient, vault: Address, functionName: string): Promise<boolean> {
  try {
    await pc.readContract({ address: vault, abi: probeAbi, functionName } as never);
    return true;
  } catch (e) {
    // a revert/no-data proves absence; a network failure must surface as retryable RPC_ERROR
    if (isRpcShapedError(e) && !isContractRevert(e)) throw e;
    return false;
  }
}

/**
 * Positive getters only — view functions that can revert for state reasons
 * can't prove absence. Returns 'unknown' rather than guessing when no
 * family-specific marker matches.
 */
export async function detectFamily(pc: PublicClient, vault: Address): Promise<Family | 'unknown'> {
  if (await probes(pc, vault, 'asset')) {
    if (await probes(pc, vault, 'lpTokenAddress')) return 'upshift_evm';
    if ((await probes(pc, vault, 'MORPHO')) || (await probes(pc, vault, 'receiveSharesGate'))) return 'morpho';
    return 'unknown';
  }
  // boring vaults have no asset(); require a Veda marker before claiming the family
  if (await probes(pc, vault, 'hook')) return 'boring';
  return 'unknown';
}

export const detectCommand: CommandDef = {
  family: '',
  name: 'detect',
  summary: 'Probe a vault on-chain and report which family it belongs to (morpho | boring | upshift_evm).',
  options: {
    vault: { type: 'string', required: true, placeholder: '<address>', description: 'Vault address to probe.' },
  },
  examples: ['smart-yield detect --vault 0xVAULT --rpc-url $RPC'],
  run: async (flags) => {
    const vault = requireAddress(flags, 'vault');
    const family = await detectFamily(makeClient(flags), vault);
    if (family === 'unknown') {
      throw new CliError('NOT_FOUND', `No supported family marker found on ${vault}.`, {
        hint: 'Supported: morpho (MORPHO/gates), boring (hook), upshift_evm (lpTokenAddress). The contract may be a receipt token or an unsupported architecture.',
      });
    }
    return { vault, family, next: `smart-yield ${family} --help` };
  },
};
