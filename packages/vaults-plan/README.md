# @sentora/vaults-plan

The unsigned transaction plan envelope shared by the Sentora vault packages (`@sentora/vaults-morpho`, `@sentora/vaults-boring`, `@sentora/vaults-upshift-financial`), plus the client types and helpers they use. No vault contract knowledge.

```sh
npm install @sentora/vaults-plan @sentora/vaults-morpho viem
```

The example below uses `@sentora/vaults-morpho`; swap in the family package you need.

## Plans

A plan is the SDK's central artifact: a complete, unsigned description of a vault action, produced entirely from read-only RPC calls and handed to whatever holds the keys: a browser wallet, a backend KMS, a Safe, an agent. Plan builders (`planDeposit`, `planRedeem`, `planRequestWithdraw`, `planClaim`, …) take only a `ReadClient` (any viem `PublicClient` fits) and cannot sign or broadcast, so a plan is inert data that is safe to log, persist, and move across process boundaries (SDK → CLI → agent → signing service). That is also why every amount in a serialized plan is a decimal string rather than a JSON-unsafe bigint.

### Lifecycle

1. **Build.** Call a family's plan builder. It reads vault state (balances, allowances, caps, pauses, gates, previews) in one preflight pass and assembles the envelope. Nothing is sent.
2. **Check `blockers`.** Every reason the action would fail is a named blocker (`INSUFFICIENT_BALANCE`, `GATE_DENIED`, `PAUSED`, …). A blocked plan is still returned (with the blockers, warnings, and any context gathered) so a UI or agent can show *why*. **Non-empty `blockers` means do not execute**; the CLI enforces this with exit code 7.
3. **Surface `warnings`.** Non-blocking cautions (e.g. "synchronous but reverts on insufficient market liquidity"). Show them; they do not forbid execution.
4. **Execute `steps` in order**, waiting for each receipt before sending the next. Steps are separate transactions: an ERC-20 approval (and, for USDT-style tokens, a preceding approve-reset) has to land before the deposit that consumes it. To send them as one batch, use a signer that executes it atomically (a Safe MultiSend, or EIP-5792 `wallet_sendCalls` with `atomicRequired: true`, viem's `forceAtomic: true`), so the approval and the deposit land or fail together. Each step carries a `kind` and human-readable `description` so a signer UI can render what it is about to sign.

```ts
import { createPublicClient, http, parseUnits } from 'viem';
import { planDeposit } from '@sentora/vaults-morpho';

const pc = createPublicClient({ transport: http(RPC_URL) });
const plan = await planDeposit(pc, vault, { assets: parseUnits('10000', 6), owner });

if (plan.blockers.length) throw new Error(plan.blockers[0].message);
// walletClient: a viem WalletClient with an account and a chain. Other signers (Privy, a backend KMS) work the
// same way; a Safe returns a safeTxHash, so wait on the Safe's execution instead of a receipt.
if (plan.chainId !== undefined && walletClient.chain.id !== plan.chainId) throw new Error('wallet is on another chain than the plan');
for (const step of plan.steps) {
  const hash = await walletClient.sendTransaction({ to: step.to, data: step.data, value: BigInt(step.value) });
  let replaced: string | undefined;
  const receipt = await pc.waitForTransactionReceipt({
    hash,
    onReplaced: ({ reason }) => { if (reason !== 'repriced') replaced = reason; },
  });
  if (replaced) throw new Error(`${step.kind} was ${replaced} in the wallet`);
  if (receipt.status !== 'success') throw new Error(`${step.kind} reverted: ${receipt.transactionHash}`);
}
```

### Reading a plan

- `expected` holds the previewed outcomes (`shares`, `assets`, `minimumMint`, …) as decimal strings in base units. They are quotes from on-chain reads at planning time (the vault's preview functions, the Boring queue's `previewAssetsOut`, the teller's share math replicated off-chain for Boring deposits, the claimable amount for Upshift claims), not guarantees; state can move between planning and execution. Where the contract supports it, plans bake a floor into the calldata instead (e.g. the boring deposit's `minimumMint`, the quote minus `slippageBps`).
- `context` carries family-specific extras a consumer needs to interpret the plan: asset/share decimals (which the CLI and MCP use to add human-readable `expectedFormatted` twins), vault version, claim dates, and so on.
- A plan is a point-in-time snapshot. Rebuild it rather than executing a stale one; building is cheap and idempotent.

The envelope's exact shape is below.

## Envelope and helpers

The serialization convention every family's plan builder returns. Types and helpers only, no contract knowledge. This is a payload convention, not a unified vault interface.

```ts
interface TxStep {
  kind: string;          // family-specific: 'approve', 'deposit', 'requestWithdraw', ...
  description: string;
  to: Address;
  data: Hex;
  value: string;         // wei as decimal string
}

interface PlanBlocker {
  code: string;
  message: string;
  available?: string;    // base units, decimal string: what the owner has or offers, or the headroom under a limit
  required?: string;     // base units, decimal string: what the action needs (for a minimum, the minimum)
  decimals?: number;     // token decimals of available/required, set only when known
}

interface Plan {
  family: string;                    // 'morpho' | 'boring' | 'upshift_evm'
  action: string;                    // 'deposit' | 'redeem' | 'requestWithdraw' | 'requestRedeem' | 'instantRedeem' | 'claim'
  chainId?: number;                  // read from the RPC (morpho, upshift_evm) or taken from cfg.chainId (boring)
  vault: Address;
  steps: TxStep[];                   // sign & send in order, waiting for each receipt
  expected: Record<string, string>;  // previewed outcomes, decimal strings
  blockers: PlanBlocker[];           // non-empty ⇒ DO NOT EXECUTE
  warnings: string[];                // non-blocking cautions
  context: Record<string, unknown>;  // family-specific extras
}
```

| Export | Description |
|---|---|
| `zeroValue: '0'` | Decimal-string zero for `TxStep.value`. |
| `blocked(plan)` | Construct a blocked `Plan`; `steps` defaults to `[]` when omitted (steps already built before the blocker may be passed through). |
| `approveNeedsReset(pc, owner, approve)` | Simulate an approve step from `owner` and return `true` when the token rejects a nonzero-to-nonzero approve (USDT-style), so the plan needs a reset to 0 first. Transport failures and transient RPC errors (rate limits, unavailable node) are rethrown; any other failure of the simulated approve counts as needing the reset. |
| `TransactionFailedError` | Thrown by `sendSimulated` (and so by every family's `core` write): `reason` is `'reverted'`, `'cancelled'` or `'replaced'` (a sped-up transaction is not an error), `hash` is the mined or original transaction hash. |
| `ContractCall` | `{ address, abi, functionName, args? }`. `sendSimulated` types `args` from the ABI and requires it: pass `[]` for functions without arguments. |
| `ReadClient` | The client methods family reads and plan builders call (`readContract`, `getChainId`, `getLogs`, `getBlock`, `call`). Taken as `pc`; a viem `PublicClient` satisfies it. |
| `WriteClient` | `ReadClient` plus `simulateContract` and `waitForTransactionReceipt`. Taken as `pc` by the `core` execute wrappers. |
| `SignerClient` | The `WalletClient` fields the execute wrappers use (`account`, `chain`, `getChainId`, `writeContract`). Taken as `wc`. |
| `sendSimulated(pc, wc, call)` | Simulate a contract write, send it, wait for the receipt. `call` is checked against its ABI, and `result` is typed from it. Throws if the wallet is on a different chain than `pc`, and throws a `TransactionFailedError` (`reason`, `hash`) if the wallet cancels or replaces the transaction or the receipt status is `reverted`. |
| `isContractRevert(error)` | `true` when a viem error is the contract reverting or returning no data; `false` for RPC and transport failures, including the node's eth_call gas cap. |
| `orOnRevert(promise, fallback)` | Resolve to `fallback` when the call reverts. RPC and transport failures still reject, so an outage is never read as the fallback value. |
| `isTransportFailure(error)` | `true` for transport failures (HTTP/socket errors, timeouts, aborts, fetch's `TypeError`) and transient JSON-RPC codes (rate limits `-32005`/`429`, `-32002`, disconnected `4900`/`4901`); `false` for reverts and other node errors (e.g. `header not found`). |
| `isAbiDecodingError(error)` | `true` when the call succeeded but its return data could not be decoded as the ABI type, e.g. the address is a different contract. |
| `isGasCapError(error)` | `true` when the node refused the call for exceeding its eth_call gas cap ("gas required exceeds allowance"). A limit of that RPC, not a revert; retrying the same endpoint does not help. |

## License

MIT. The LICENSE file ships in this package.
