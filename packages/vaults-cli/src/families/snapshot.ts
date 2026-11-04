import type { Address, PublicClient } from 'viem';
import * as morpho from '@sentora/vaults-morpho';
import * as uf from '@sentora/vaults-upshift-financial';
import * as boring from '@sentora/vaults-boring';
import { evmChainId, type YieldsClient, type YieldsVault } from '@sentora/yields-client';
import { detectFamily } from './detect';
import { baseOpts, catalogVaults, client } from './yields';
import { CliError, sanitizeErrorMessage } from '../errors';
import { isAddress, makeClient, optionalAddress, requireString, shown } from '../helpers';
import { vlog } from '../verbose';
import type { CommandDef } from '../types';

const SUPPORTED_FAMILY_VERSION = 1;

type Catalog = { vaults: YieldsVault[]; apiError?: string };
type Lookup = { record?: YieldsVault; chainId?: number; listedOn: string[]; catalogError?: string; head: Record<string, unknown> };

async function loadCatalog(api: YieldsClient | Error): Promise<Catalog> {
  if (api instanceof Error) return { vaults: [], apiError: sanitizeErrorMessage(api.message) };
  try {
    const { vaults, error } = catalogVaults(await api.listVaults());
    return { vaults, apiError: error };
  } catch (e) {
    const apiError = sanitizeErrorMessage((e as Error).message);
    vlog(`snapshot: yields api unavailable, falling back to on-chain detection (${apiError})`);
    return { vaults: [], apiError };
  }
}

function findRecord(vaults: YieldsVault[], vault: string, chainId: number | undefined): { record?: YieldsVault; listedOn: string[] } {
  const want = vault.toLowerCase();
  const matches = vaults.filter((v) => typeof v?.contracts?.vault === 'string' && v.contracts.vault.toLowerCase() === want);
  const listedOn = matches.map((v) => (typeof v.chainId === 'string' ? v.chainId : '?'));
  if (chainId === undefined) return { record: matches.length === 1 ? matches[0] : undefined, listedOn };
  return { record: matches.find((v) => typeof v.chainId === 'string' && evmChainId(v.chainId) === chainId), listedOn };
}

/**
 * One-call preflight per vault: family + meta + (with --owner) gates/position.
 * Batchable: --vault accepts a comma-separated list, snapshots run in parallel,
 * and a failing vault yields an { error } item instead of killing the batch.
 */
async function snapshotOne(pc: PublicClient, vault: Address, { record, chainId, listedOn, catalogError, head }: Lookup, owner?: Address): Promise<Record<string, unknown>> {
  const family = record?.family ?? (await detectFamily(pc, vault));
  const base: Record<string, unknown> = { ...head, family };
  const familyVersion = record?.familyVersion ?? SUPPORTED_FAMILY_VERSION;
  if (familyVersion !== SUPPORTED_FAMILY_VERSION) {
    return { ...base, error: `familyVersion ${familyVersion} of '${family}' is not supported by this CLI; upgrade @sentora/vaults-cli` };
  }

  switch (family) {
    case 'morpho': {
      const meta = await morpho.getVaultMeta(pc, vault);
      const [gates, position] = owner
        ? await Promise.all([morpho.checkGates(pc, vault, owner), morpho.getPosition(pc, vault, meta.asset, owner)])
        : [undefined, undefined];
      return { ...base, meta, ...(gates && { gates }), ...(position && { position }) };
    }
    case 'upshift_evm': {
      const meta = await uf.getVaultMeta(pc, vault);
      const [gates, position] = owner
        ? await Promise.all([uf.checkGates(pc, vault, owner), uf.getPosition(pc, vault, meta.asset, owner)])
        : [undefined, undefined];
      return { ...base, meta, ...(gates && { gates }), ...(position && { position }) };
    }
    case 'boring': {
      const c = record?.contracts;
      if (!c?.teller || !c?.accountant || !c?.queue || !c?.rolesAuthority || !record?.depositToken?.address) {
        const where = chainId === undefined ? 'an unknown chain (RPC unreachable)' : `eip155:${chainId}`;
        const elsewhere = !record && listedOn.length > 0 ? ` (listed on ${listedOn.join(', ')}; check --rpc-url)` : '';
        const cause = catalogError ? `the yields API lookup failed (${catalogError})` : `boring topology is not in the catalog for ${where}${elsewhere}`;
        return { ...base, error: `${cause}; use 'smart-yield boring discover' with explicit flags` };
      }
      // catalog records are external data, validate before use
      const addrs: Record<string, string> = {
        teller: c.teller, accountant: c.accountant, queue: c.queue,
        rolesAuthority: c.rolesAuthority, depositToken: record.depositToken.address,
      };
      for (const [field, value] of Object.entries(addrs)) {
        if (!isAddress(value)) return { ...base, error: `catalog record has an invalid ${field} address — re-run discovery with explicit flags` };
      }
      const chainIdNum = chainId ?? (record.chainId ? evmChainId(record.chainId) : undefined);
      if (chainIdNum === undefined) {
        return { ...base, error: `could not resolve an EVM chain id for this vault (record chainId '${String(record.chainId)}')` };
      }
      const cfg = {
        vault, teller: c.teller as Address, accountant: c.accountant as Address,
        queue: c.queue as Address, rolesAuthority: c.rolesAuthority as Address,
        chainId: chainIdNum,
      };
      const asset = record.depositToken.address as Address;
      const [preflight, position] = owner
        ? await Promise.all([boring.preflight(pc, cfg, asset, owner), boring.getPosition(pc, cfg, asset, owner)])
        : [undefined, undefined];
      return { ...base, config: cfg, asset, ...(preflight && { preflight }), ...(position && { position }) };
    }
    default:
      return { ...base, error: `no SDK adapter for family '${family}'` };
  }
}

export const snapshotCommand: CommandDef = {
  family: '',
  name: 'snapshot',
  summary: 'One-call vault preflight: family + meta (+ gates and position with --owner). --vault takes a comma-separated list for batch evaluation.',
  options: {
    ...baseOpts,
    vault: { type: 'string', required: true, placeholder: '<addr>[,<addr>…]', description: 'Vault address, or a comma-separated list to snapshot in one call.' },
    owner: { type: 'string', placeholder: '<address>', description: 'Include gates/preflight and position for this account.' },
  },
  examples: [
    'smart-yield snapshot --vault 0xVAULT --owner 0xOWNER --rpc-url $RPC',
    'smart-yield snapshot --vault "0xA,0xB,0xC" --rpc-url $RPC',
  ],
  run: async (flags) => {
    const pc = makeClient(flags);
    const owner = optionalAddress(flags, 'owner');
    const vaults = requireString(flags, 'vault').split(',').map((v) => v.trim());
    for (const v of vaults) {
      if (!isAddress(v)) throw new CliError('USAGE', `--vault entries must be 0x addresses, got '${shown(v)}'.`);
    }
    // An explicit --base-url is validated like every yields command; a bad env config only loses the catalog
    let api: YieldsClient | Error;
    try {
      api = client(flags);
    } catch (e) {
      if (typeof flags['base-url'] === 'string') throw e;
      api = e as Error;
    }
    const [catalog, chainId] = await Promise.all([loadCatalog(api), pc.getChainId().catch(() => undefined)]);
    const items = await Promise.all(
      vaults.map((v) => {
        const { record, listedOn } = findRecord(catalog.vaults, v, chainId);
        const head: Record<string, unknown> = {
          vault: v,
          ...(record?.family && { family: record.family }),
          ...(record && { name: record.name }),
          ...(catalog.apiError && { catalogError: catalog.apiError }),
          ...(!record && listedOn.length > 0 && { listedOn }),
        };
        return snapshotOne(pc, v as Address, { record, chainId, listedOn, catalogError: catalog.apiError, head }, owner).catch((e) => ({
          ...head,
          error: sanitizeErrorMessage((e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message),
        }));
      }),
    );
    return vaults.length === 1 ? items[0] : items;
  },
};
