/**
 * On-chain topology discovery from the vault address alone.
 *
 * Point reads: vault.authority() → RolesAuthority; vault.hook() → Teller
 * (Veda wires the before-transfer hook to the teller for the share lock);
 * teller.accountant() → Accountant.
 *
 * The QUEUE has no reverse pointer — it is found by scanning the authority's
 * RoleCapabilityUpdated / PublicCapabilityUpdated events and probing each
 * target for boringVault() == vault, skipping deprecated queues (see
 * isQueueDeprecated: a migrated-away queue keeps its boringVault()). Full-range
 * eth_getLogs: fine on a fork or archive RPC, may be slow or capped
 * elsewhere — cache the result, pass `queue` or `queues` to skip the scan, or
 * set `skipQueueScan` when only deposits are needed.
 */
import { zeroAddress, type Address } from 'viem';
import { isAbiDecodingError, isTransportFailure, orOnRevert, type ReadClient } from '@sentora/vaults-plan';
import { boringVaultAbi, tellerAbi, boringQueueAbi, rolesAuthorityAbi } from './abi.js';
import { isQueueDeprecated, type BoringVaultConfig } from './core.js';

export interface DiscoverOptions {
  teller?: Address;
  queue?: Address;
  fromBlock?: bigint;
  /** candidate queues in order of preference: the first that belongs to the vault and is not deprecated wins */
  queues?: Address[];
  /** with neither `queue` nor `queues`, skip the authority event scan: deposits work, withdrawals report QUEUE_UNKNOWN */
  skipQueueScan?: boolean;
}

export interface DiscoveredConfig {
  config: BoringVaultConfig;
  /** true when no queue was found — deposit plans work, withdrawals don't */
  queueUnknown: boolean;
  /** true when the explicit queue no longer accepts withdrawal requests (reads still work) */
  queueDeprecated: boolean;
  warnings: string[];
}

/**
 * Discovers the full contract topology from the vault address alone: teller
 * via vault.hook(), accountant via teller.accountant(), authority via
 * vault.authority(). The queue has no reverse pointer and is found by a
 * full-range authority event scan — this can be slow or capped on non-archive
 * RPCs, so cache the result or pass `queue` explicitly to skip the scan.
 * Explicit teller/queue overrides are verified against the vault; an explicit
 * deprecated queue is kept (reads still work) but flagged with `queueDeprecated`.
 * Reverts or undecodable data on boringVault() mean "not this queue". Network
 * and transient RPC failures reject on every path so callers retry. For an
 * explicit queue and `queues` any other failure rejects too; the scan skips
 * such a target and names it in `warnings`.
 *
 * @param pc - `ReadClient` used for the reads and the event scan.
 * @param vault - BoringVault (share token) address to discover from.
 * @param opts - Optional overrides: explicit `teller`, explicit `queue` (skips the event scan), candidate `queues` (first active one wins, never falls back to the event scan), `skipQueueScan` (no scan when neither `queue` nor `queues` is given), and `fromBlock` to bound the scan (default 0).
 * @returns A `DiscoveredConfig` with `config` (the assembled BoringVaultConfig), `queueUnknown` (true when no queue was found — deposit plans work, withdrawals don't), `queueDeprecated` (explicit queue no longer accepts withdrawal requests), and `warnings` from partial or failed scans.
 */
export async function discoverConfig(pc: ReadClient, vault: Address, opts: DiscoverOptions = {}): Promise<DiscoveredConfig> {
  const warnings: string[] = [];

  const [authority, hook, chainId] = await Promise.all([
    pc.readContract({ address: vault, abi: boringVaultAbi, functionName: 'authority' }),
    opts.teller
      ? Promise.resolve(opts.teller)
      : pc.readContract({ address: vault, abi: boringVaultAbi, functionName: 'hook' }),
    pc.getChainId(),
  ]);

  const teller = hook as Address;
  if (teller === zeroAddress) {
    throw new Error(
      `@sentora/vaults-boring: vault ${vault} has no before-transfer hook set — cannot derive the teller. Pass { teller } explicitly.`,
    );
  }

  const [tellerVault, accountant] = await Promise.all([
    pc.readContract({ address: teller, abi: tellerAbi, functionName: 'vault' }),
    pc.readContract({ address: teller, abi: tellerAbi, functionName: 'accountant' }),
  ]);
  if (tellerVault.toLowerCase() !== vault.toLowerCase()) {
    throw new Error(
      `@sentora/vaults-boring: derived teller ${teller} points at vault ${tellerVault}, not ${vault}. Pass { teller } explicitly.`,
    );
  }

  let queue = opts.queue ?? zeroAddress;
  const explicitQueue = queue !== zeroAddress;
  let queueDeprecated = false;
  let queueAuthority: Address | undefined | null;
  if (explicitQueue) {
    // an explicit queue becomes the share-approval spender — verify it belongs to this vault
    const [linked, deprecated, explicitAuthority] = await Promise.all([
      readLinkedVault(pc, queue),
      isQueueDeprecated(pc, authority, queue).catch((e: unknown) => (isTransportFailure(e) ? Promise.reject(e) : undefined)),
      readQueueAuthority(pc, queue),
    ]);
    queueAuthority = explicitAuthority;
    if (linked.toLowerCase() !== vault.toLowerCase()) {
      throw new Error(
        `@sentora/vaults-boring: queue ${queue} reports boringVault() = ${linked}, not ${vault} — wrong, stale, or non-queue address.`,
      );
    }
    queueDeprecated = deprecated === true;
    if (deprecated === undefined) {
      warnings.push(`Could not read whether queue ${queue} still accepts withdrawal requests — withdrawal plans re-check it.`);
    } else if (deprecated) {
      warnings.push(`Queue ${queue} is deprecated: the vault's authority grants requestOnChainWithdraw on it to no one, so new withdrawal requests are disabled. Use the vault's current queue for new requests.`);
    }
  } else if (opts.queues !== undefined && opts.queues.length > 0) {
    queue = await pickQueue(pc, authority, vault, opts.queues, warnings);
    if (queue === zeroAddress) {
      warnings.push('None of the candidate queues is active — withdrawal plans unavailable until a current queue is passed.');
    }
  } else if (opts.skipQueueScan) {
    warnings.push('Queue scan skipped — withdrawal plans unavailable until a queue is passed explicitly.');
  } else {
    const found = await findQueue(pc, authority, vault, opts.fromBlock ?? 0n);
    queue = found.queue;
    if (found.partialScan) {
      warnings.push('Authority event scan failed or was truncated by the RPC — queue discovery may be incomplete. Bound the scan with fromBlock or pass the queue explicitly.');
    }
    if (found.unreadTargets.length > 0) {
      warnings.push(`Could not read boringVault() on ${found.unreadTargets.length} authority target(s) (${found.unreadTargets.join(', ')}) — skipped; pass the queue explicitly if it is one of them.`);
    }
    if (found.unverified) {
      warnings.push(`Could not read whether queue ${queue} still accepts withdrawal requests — using it unverified; withdrawal plans re-check it.`);
    }
    if (queue === zeroAddress && found.deprecated > 0) {
      warnings.push(`Found ${found.deprecated} BoringOnChainQueue(s) linked to the vault, all deprecated (withdrawal requests disabled) — pass the current queue explicitly.`);
    } else if (queue === zeroAddress) {
      warnings.push('No BoringOnChainQueue found via authority event scan — withdrawal plans unavailable until one is passed explicitly.');
    }
  }

  if (queue !== zeroAddress && !explicitQueue) {
    queueAuthority = await readQueueAuthority(pc, queue);
  }
  if (queueAuthority === null) {
    warnings.push(`Could not read queue ${queue}'s authority — withdrawal permission checks assume it is the vault's ${authority}.`);
  }
  // requestOnChainWithdraw is enforced by the queue's own authority; the checks here read the vault's
  if (typeof queueAuthority === 'string' && queueAuthority.toLowerCase() !== authority.toLowerCase()) {
    warnings.push(`Queue ${queue} uses authority ${queueAuthority}, not the vault's ${authority} — withdrawal permission checks may not match on-chain behavior.`);
  }

  return {
    config: { vault, teller, accountant, queue, rolesAuthority: authority, chainId },
    queueUnknown: queue === zeroAddress,
    queueDeprecated,
    warnings,
  };
}

// only feeds a warning: a revert means no authority() getter (undefined), any other failure is reported as unread (null)
const readQueueAuthority = (pc: ReadClient, queue: Address): Promise<Address | undefined | null> =>
  orOnRevert(pc.readContract({ address: queue, abi: boringQueueAbi, functionName: 'authority' }), undefined).catch(() => null);

const readLinkedVault = (pc: ReadClient, queue: Address): Promise<Address> =>
  orOnRevert(pc.readContract({ address: queue, abi: boringQueueAbi, functionName: 'boringVault' }), zeroAddress)
    .catch((e: unknown) => (isAbiDecodingError(e) ? zeroAddress : Promise.reject(e)));

// scan targets are arbitrary contracts: a network or transient failure rejects, a revert or bad data means "not a queue",
// and anything else (out of gas, node errors) is reported as unreadable (null)
const probeLinkedVault = (pc: ReadClient, target: Address): Promise<Address | null> =>
  readLinkedVault(pc, target).catch((e: unknown) => (isTransportFailure(e) ? Promise.reject(e) : null));

// Reverts mean "not a queue of this vault"; RPC failures reject so callers retry instead of settling on a worse queue.
async function pickQueue(
  pc: ReadClient, authority: Address, vault: Address, candidates: Address[], warnings: string[],
): Promise<Address> {
  for (const candidate of candidates) {
    const linked = await readLinkedVault(pc, candidate);
    if (linked.toLowerCase() !== vault.toLowerCase()) {
      warnings.push(`Candidate queue ${candidate} reports boringVault() = ${linked}, not ${vault} — skipped.`);
      continue;
    }
    if (await isQueueDeprecated(pc, authority, candidate)) {
      warnings.push(`Candidate queue ${candidate} is deprecated — skipped.`);
      continue;
    }
    return candidate;
  }
  return zeroAddress;
}

async function findQueue(
  pc: ReadClient, authority: Address, vault: Address, fromBlock: bigint,
): Promise<{ queue: Address; partialScan: boolean; deprecated: number; unverified: boolean; unreadTargets: Address[] }> {
  const targets = new Set<Address>();
  let partialScan = false;
  let deprecated = 0;
  let unreadable: Address | undefined;
  const unreadTargets: Address[] = [];
  const abiEvents = rolesAuthorityAbi.filter((e) => e.type === 'event');
  for (const event of abiEvents) {
    try {
      const logs = await pc.getLogs({ address: authority, event, fromBlock, toBlock: 'latest' });
      for (const log of logs) {
        const target = (log.args as { target?: Address }).target;
        if (target) targets.add(target);
      }
    } catch {
      // RPC caps full-range getLogs — continue with the partial target set and flag it
      partialScan = true;
    }
  }

  // newest-first: after a queue migration the most recently wired queue must win over a deprecated one
  for (const target of [...targets].reverse()) {
    if (target.toLowerCase() === vault.toLowerCase()) continue;
    const linked = await probeLinkedVault(pc, target);
    if (linked === null) {
      unreadTargets.push(target);
      continue;
    }
    if (linked.toLowerCase() !== vault.toLowerCase()) continue;
    try {
      if (!(await isQueueDeprecated(pc, authority, target))) return { queue: target, partialScan, deprecated, unverified: false, unreadTargets };
      deprecated++;
    } catch (e) {
      if (isTransportFailure(e)) throw e;
      unreadable ??= target;
    }
  }
  return unreadable
    ? { queue: unreadable, partialScan, deprecated, unverified: true, unreadTargets }
    : { queue: zeroAddress, partialScan, deprecated, unverified: false, unreadTargets };
}
