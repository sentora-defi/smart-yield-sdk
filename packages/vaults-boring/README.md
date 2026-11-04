# @sentora/vaults-boring

Boring (Veda) vaults: teller deposits, accountant-rated pricing, async solver-based withdrawals via BoringOnChainQueue. Adds a `discover` layer that derives the contract topology from the vault address alone.

```sh
npm install @sentora/vaults-boring @sentora/vaults-plan viem
```

Every family package has three layers:

- `encode`: pure calldata builders. No RPC, no signer. Return `TxStep`.
- `plan`: read-only RPC preflight. Return an unsigned `Plan` (steps + expected outcomes + blockers/warnings). A plan with a non-empty `blockers` array must not be executed.
- `core`: reads (metadata, positions, previews, gates) plus execute wrappers for apps that hold a viem `WalletClient`. Every write is simulated before sending, throws if the wallet is on another chain, and throws a `TransactionFailedError` (exported by `@sentora/vaults-plan`) if the wallet cancels or replaces it or its receipt status is `reverted`.

Amounts are `bigint` in the API and decimal strings in serialized plans. The package makes no HTTP calls and reads no environment variables: everything comes from the arguments and from the chain through the read client you pass (any viem `PublicClient` fits). The plan envelope and the client types come from [`@sentora/vaults-plan`](https://www.npmjs.com/package/@sentora/vaults-plan).

**Key types**

| Type | Fields |
|---|---|
| `BoringVaultConfig` | `{ vault, teller, accountant, queue, rolesAuthority, chainId, label? }`. Per-vault topology: `vault` is the share token and deposit-approval target; `queue` is the withdrawal entrypoint and share-approval target. |
| `TellerDepositVariant` | `'v1'` (3-arg) \| `'v2'` (4-arg with referral). |
| `BoringPreflight` | `{ canDeposit, tellerDepositVariant, tellerPaused, assetAllowed, sharePremiumBps, shareUnlockTime, sharesLocked }` |
| `BoringPosition` | `{ shares, assets, assetBalance, vaultAllowance, queueShareAllowance }` |
| `WithdrawAssetConfig` | `{ allowWithdraws, secondsToMaturity, minimumSecondsToDeadline, minDiscountBps, maxDiscountBps, minimumShares }` |
| `OnChainWithdrawRequest` | `{ nonce, user, assetOut, amountOfShares, amountOfAssets, creationTime, secondsToMaturity, secondsToDeadline }`. Persist this from the request event; required to cancel. |
| `DiscoverOptions` | `{ teller?, queue?, queues?, fromBlock?, skipQueueScan? }`. `queues`: candidates in order of preference, the first that belongs to the vault and is not deprecated wins; with none active the queue stays unknown, there is no fallback to the event scan. On every discovery path a network or transient RPC failure on a queue's `boringVault()` or on its deprecation check rejects instead of being read as "not a queue" or "not deprecated"; the event scan skips targets that fail for other reasons and lists them in `warnings`. |
| `DiscoveredConfig` | `{ config: BoringVaultConfig, queueUnknown: boolean, queueDeprecated: boolean, warnings: string[] }` |

**Discover**

| Function | Description |
|---|---|
| `discoverConfig(pc, vault, opts?)` | → `Promise<DiscoveredConfig>`. Derives teller/accountant from vault hooks and event-scans the RolesAuthority for the queue (newest-first), skipping deprecated queues. `queueUnknown: true` ⇒ deposit plans work, withdrawals don't. `queueDeprecated: true` ⇒ the explicit queue no longer accepts withdrawal requests. `skipQueueScan: true` (neither `queue` nor `queues`) skips the event scan: deposits work, withdrawals report `QUEUE_UNKNOWN`. |

**Core reads**

| Function | Description |
|---|---|
| `preflight(pc, cfg, asset, user)` | → `Promise<BoringPreflight>`. Role/pause/asset/lock deposit preflight. |
| `getPosition(pc, cfg, asset, user)` | → `Promise<BoringPosition>`. Priced via the accountant's pushed rate. |
| `previewDepositShares(pc, cfg, asset, amount)` | → `Promise<bigint>`. Replicates the teller's share math (no on-chain previewDeposit exists). |
| `getWithdrawAssetConfig(pc, cfg, assetOut)` | → `Promise<WithdrawAssetConfig>` |
| `previewWithdrawAssets(pc, cfg, assetOut, shares, discountBps)` | → `Promise<bigint>`. Expected output after solver discount. |
| `isQueueDeprecated(pc, authority, queue)` | → `Promise<boolean>`. True when the vault's RolesAuthority grants `requestOnChainWithdraw` on the queue to no one (a retired queue). |
| `readAssetAllowance(pc, cfg, asset, owner)` | → `Promise<bigint>` |
| `isRequestPending(pc, cfg, requestId)` | → `Promise<boolean>` |

**Plan**

| Function | Params | Notes |
|---|---|---|
| `planDeposit(pc, cfg, params)` | `BoringDepositParams { asset, amount, owner, slippageBps? }` (`slippageBps` default 50 = 0.5% haircut for `minimumMint`) | Blockers: paused, asset not allowed, role denied, insufficient balance. `expected: { shares, minimumMint }`. Shares mint to msg.sender. |
| `planRequestWithdraw(pc, cfg, params)` | `BoringWithdrawParams { assetOut, shares, owner, discountBps?, secondsToDeadline? }` (defaults: queue minimum discount; max(queue minimum, 3 days) deadline) | Blockers, in order: unknown queue, deprecated queue (`QUEUE_DEPRECATED`) or role denied (`ROLE_DENIED`), paused, asset not allowed, minimum shares, discount range, insufficient shares, shares locked. Withdrawal is async (solver queue). |

**Encode**: `encodeApproveAsset(cfg, asset, amount)`, `encodeApproveAssetReset(cfg, asset)`, `encodeDeposit(cfg, asset, amount, minimumMint, variant?, referral?)`, `encodeApproveSharesToQueue(cfg, shares)`, `encodeRequestWithdraw(cfg, assetOut, shares, discountBps, secondsToDeadline)`. All return `TxStep`. Asset approvals target the vault, share approvals target the queue.

**Core writes**

| Function | Returns |
|---|---|
| `approveAsset(pc, wc, cfg, asset, amount)` | `{ hash }` |
| `deposit(pc, wc, cfg, asset, amount, minimumMint, variant?, referral?)` | `{ hash, shares }`. Pass `preflight`'s `tellerDepositVariant` as `variant`: it is `'v2'` when the 4-arg referral deposit is callable. `referral` is only sent with `'v2'`. |
| `approveSharesToQueue(pc, wc, cfg, shares)` | `{ hash }` |
| `requestWithdraw(pc, wc, cfg, assetOut, shares, discountBps, secondsToDeadline)` | `{ hash, requestId, request }`. Persist `request` for cancellation. Throws if the receipt has no `OnChainWithdrawRequested` event from the queue. |
| `cancelWithdraw(pc, wc, cfg, request)` | `{ hash }`. Requires the full persisted struct. |

ABI constants: `boringVaultAbi`, `tellerAbi`, `tellerDepositV2Abi`, `accountantAbi`, `boringQueueAbi`, `rolesAuthorityAbi`, `erc20Abi`, `TELLER_DEPOSIT_SELECTOR`, `TELLER_DEPOSIT_SELECTOR_V2`, `QUEUE_REQUEST_WITHDRAW_SELECTOR`.

## License

MIT. The LICENSE file ships in this package.
