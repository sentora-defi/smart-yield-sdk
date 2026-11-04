# @sentora/vaults-morpho

Morpho Vaults (V1 MetaMorpho and V2): ERC-4626 deposits/withdrawals with V2 gate preflight.

```sh
npm install @sentora/vaults-morpho @sentora/vaults-plan viem
```

Every family package has three layers:

- `encode`: pure calldata builders. No RPC, no signer. Return `TxStep`.
- `plan`: read-only RPC preflight. Return an unsigned `Plan` (steps + expected outcomes + blockers/warnings). A plan with a non-empty `blockers` array must not be executed.
- `core`: reads (metadata, positions, previews, gates) plus execute wrappers for apps that hold a viem `WalletClient`. Every write is simulated before sending, throws if the wallet is on another chain, and throws a `TransactionFailedError` (exported by `@sentora/vaults-plan`) if the wallet cancels or replaces it or its receipt status is `reverted`.

Amounts are `bigint` in the API and decimal strings in serialized plans. The package makes no HTTP calls and reads no environment variables: everything comes from the arguments and from the chain through the read client you pass (any viem `PublicClient` fits). The plan envelope and the client types come from [`@sentora/vaults-plan`](https://www.npmjs.com/package/@sentora/vaults-plan).

**Encode** (pure calldata → `TxStep`)

| Function | Description |
|---|---|
| `encodeApprove(asset, vault, amount)` | ERC-20 approval for the vault to pull assets. |
| `encodeApproveReset(asset, vault)` | Reset approval to 0 (USDT-style tokens). |
| `encodeDeposit(vault, assets, receiver)` | ERC-4626 deposit. |
| `encodeWithdraw(vault, assets, receiver, owner)` | ERC-4626 withdraw by exact assets. |
| `encodeRedeem(vault, shares, receiver, owner)` | ERC-4626 redeem by exact shares. |

**Plan**

| Function | Params | Notes |
|---|---|---|
| `planDeposit(pc, vault, params)` | `MorphoDepositParams { assets: bigint; owner: Address; receiver?: Address }` | Blockers: gate denied (V2), insufficient balance. `context.version: 'v1' \| 'v2'`. |
| `planRedeem(pc, vault, params)` | `MorphoRedeemParams { shares: bigint; owner: Address; receiver?: Address }` | Blockers: gate denied, insufficient shares. Warning: reverts when underlying market liquidity is insufficient. |

**Core**

| Export | Signature / fields |
|---|---|
| `MorphoVaultMeta` | `{ vault, shareSymbol, shareDecimals, asset, assetSymbol, assetDecimals, totalAssets, isV2 }` |
| `getVaultMeta(pc, vault)` | → `Promise<MorphoVaultMeta>`. V2 detected via gate getters. |
| `MorphoPosition` | `{ shares, assets, assetBalance, allowance, maxWithdrawRaw }`. **`maxWithdrawRaw` is always 0 on V2 by design**; never use it as a UI cap there. |
| `getPosition(pc, vault, asset, user)` | → `Promise<MorphoPosition>` |
| `GateCheck` | `{ gated, canDeposit, canWithdraw }` |
| `checkGates(pc, vault, user)` | → `Promise<GateCheck>`. Cheap V2 eligibility preflight; returns all-true/ungated on V1. |
| `previewDeposit(pc, vault, assets)` / `previewRedeem(pc, vault, shares)` | → `Promise<bigint>` |
| `approve(pc, wc, asset, vault, amount)` | → `{ hash }` |
| `deposit(pc, wc, vault, assets, receiver)` | → `{ hash, shares }` |
| `redeem(pc, wc, vault, shares, receiver, owner)` | → `{ hash, assets }`. Synchronous but reverts on insufficient market liquidity. |
| `withdraw(pc, wc, vault, assets, receiver, owner)` | → `{ hash, shares }`. Same liquidity caveat. |
| `morphoVaultAbi`, `gateAbi`, `erc20Abi` | ABI constants. |

## License

MIT. The LICENSE file ships in this package.
