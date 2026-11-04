# @sentora/vaults-upshift-financial

Upshift TokenizedVault: multi-asset deposits, epoch-queued or instant redemptions, separate LP receipt token (LayerZero OFT).

```sh
npm install @sentora/vaults-upshift-financial @sentora/vaults-plan viem
```

Every family package has three layers:

- `encode`: pure calldata builders. No RPC, no signer. Return `TxStep`.
- `plan`: read-only RPC preflight. Return an unsigned `Plan` (steps + expected outcomes + blockers/warnings). A plan with a non-empty `blockers` array must not be executed.
- `core`: reads (metadata, positions, previews, gates) plus execute wrappers for apps that hold a viem `WalletClient`. Every write is simulated before sending, throws if the wallet is on another chain, and throws a `TransactionFailedError` (exported by `@sentora/vaults-plan`) if the wallet cancels or replaces it or its receipt status is `reverted`.

Amounts are `bigint` in the API and decimal strings in serialized plans. The package makes no HTTP calls and reads no environment variables: everything comes from the arguments and from the chain through the read client you pass (any viem `PublicClient` fits). The plan envelope and the client types come from [`@sentora/vaults-plan`](https://www.npmjs.com/package/@sentora/vaults-plan).

**Key types**

| Type | Fields |
|---|---|
| `VaultMeta` | `{ vault, lpToken, shareSymbol, shareDecimals, asset, assetSymbol, assetDecimals, totalAssets, totalSupply, sharePrice, depositsPaused, withdrawalsPaused, depositCap, maxDepositAmount, maxWithdrawalAmount, instantRedemptionFee, withdrawalFee, lagDuration }`. `lagDuration === 0n` means no timelock; `requestRedeem` reverts, use instant. |
| `Position` | `{ shares, assets, assetBalance, allowance, shareAllowance }`. `shareAllowance` (LP → vault) is needed for the queued path only. |
| `GateCheck` | `{ sendersGated, canSend, assetAllowed }` |
| `ClaimDate` | `{ year, month, day }` |
| `RedeemRequestResult` | `{ hash, claimableEpoch, claimDate }` |
| `WithdrawalRequest` | `{ requestedAt, blockNumber? }`. `requestedAt` is the unix-seconds timestamp of the block that mined `requestRedeem`. |
| `PendingWithdrawal` | `{ date, shares, claimableEpoch, status }`. `status` turns `'claimable'` at `claimableEpoch`, the same rule as `planClaim`'s `TOO_EARLY`; requests that landed on the same date are summed. |

**Core reads**

| Function | Description |
|---|---|
| `getVaultMeta(pc, vault)` | → `Promise<VaultMeta>` |
| `getPosition(pc, vault, asset, user)` | → `Promise<Position>` |
| `checkGates(pc, vault, user, assetIn?)` | → `Promise<GateCheck>`. Senders/assets whitelist preflight; reference asset always allowed. |
| `previewDeposit(pc, vault, assetIn, amountIn)` | → `Promise<{ shares, amountInReferenceTokens }>` |
| `previewRedemption(pc, vault, shares, instant)` | → `Promise<{ assetsAmount, assetsAfterFee }>` |
| `getWithdrawalEpoch(pc, vault)` | → `Promise<ClaimDate & { claimableEpoch }>`. Epoch a redemption requested now would land on. |
| `claimDateForRequest(requestedAt, lagDuration)` | → `ClaimDate`. Rebuilds the date `requestRedeem` assigned to a request mined at `requestedAt` (UTC day of `requestedAt + 300s + lagDuration`), for requests without a block. |
| `getPendingWithdrawals(pc, vault, receiver, requests)` | → `Promise<PendingWithdrawal[]>`. Unpaid queued redemptions for `receiver`, however old, oldest first. With `blockNumber`, the vault dates the request itself (`getWithdrawalEpoch` read at that block; needs an archive RPC, a failed read throws `HistoricEpochUnavailableError`); without it, `claimDateForRequest` with the current `lagDuration`. |
| `withdrawalRequestsFromActivity(rows)` | → `WithdrawalRequest[]`. Keeps the `WITHDRAW_REQUEST` rows of a yields API activity response; throws `InvalidActivityError` on a malformed response. |
| `getPendingWithdrawalsFromActivity(pc, vault, receiver, rows)` | → `Promise<{ withdrawals, requestCount, historicReadErrors }>`. `getPendingWithdrawals` straight from the activity rows of the account that called `requestRedeem` (the API indexes them under it; no `yields-client` dependency). A request whose block can't be read is dated with the current `lagDuration` and its error is returned in `historicReadErrors`. |
| `getClaimable(pc, vault, date, receiver)` | → `Promise<{ shares, executionEpoch }>` |

**Plan**

| Function | Params | Notes |
|---|---|---|
| `planDeposit(pc, vault, params)` | `DepositParams { amount, owner, receiver?, assetIn? }` (`assetIn` defaults to the reference asset; any whitelisted asset accepted) | Blockers: paused, sender not whitelisted, asset not allowed, zero-share amount, insufficient balance, per-tx max, total cap. `expected: { shares, amountInReferenceTokens }`. |
| `planRedeem(pc, vault, params)` | `RedeemParams { shares, owner, receiver?, instant? }` | Default is the epoch queue (approve shares + requestRedeem); `instant: true` burns immediately with a fee. Blockers: paused, sender not whitelisted, insufficient shares, per-tx withdrawal limit, zero-asset amount, no timelock (queued only). Queued plans include `context.claimDate` / `claimableEpoch`. |
| `planClaim(pc, vault, params)` | `ClaimParams { date: ClaimDate, owner, receiver? }` | Blockers: paused, not whitelisted, nothing to claim, too early. |

**Encode**: `encodeApprove(asset, vault, amount)`, `encodeApproveReset(asset, vault)`, `encodeApproveShares(lpToken, vault, shares)`, `encodeDeposit(vault, assetIn, amountIn, receiver)`, `encodeRequestRedeem(vault, shares, receiver)`, `encodeInstantRedeem(vault, shares, receiver)`, `encodeClaim(vault, date, receiver)`. All return `TxStep`.

**Core writes**

| Function | Returns |
|---|---|
| `approve(pc, wc, asset, vault, amount)` | `{ hash }` |
| `approveShares(pc, wc, lpToken, vault, shares)` | `{ hash }` (queued path only) |
| `deposit(pc, wc, vault, assetIn, amountIn, receiver)` | `{ hash, expectedShares }` |
| `requestRedeem(pc, wc, vault, shares, receiver)` | `RedeemRequestResult` |
| `instantRedeem(pc, wc, vault, shares, receiver)` | `{ hash }` |
| `claim(pc, wc, vault, date, receiver)` | `{ hash, assetsAmount, assetsAfterFee }` |

ABI constants: `tokenizedVaultAbi`, `whitelistAbi`, `erc20Abi`.

## License

MIT. The LICENSE file ships in this package.
