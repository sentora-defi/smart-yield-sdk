# @sentora/yields-client

Typed fetch client for the Sentora yields API (vault discovery, analytics, risk, user positions).

```sh
npm install @sentora/yields-client
```

```ts
import { YieldsClient } from '@sentora/yields-client';
const client = new YieldsClient({ apiKey: process.env.YIELDS_API_KEY });
const vaults = await client.listVaults();
```

**Constructor**: `new YieldsClient(opts?: YieldsClientOptions)` with `{ baseUrl?, apiKey?, userAgent?, fetchImpl? }`. Defaults: `DEFAULT_BASE_URL = 'https://services.vaults.sentora.com'`, self-identifying `DEFAULT_USER_AGENT` (it embeds `CLIENT_VERSION`, the package version). `baseUrl` must be HTTPS (plain HTTP allowed on loopback only). When an API key is set, redirects are refused. An HTTP error status or a non-JSON body throws `YieldsApiError { status, path }` with a sanitized upstream body. Anything else throws what `fetchImpl` or the body read throws; with Node's fetch that is a `TypeError` for network failures, a cut-off body and a redirect refused because an API key is set, and a `DOMException` (`AbortError` / `TimeoutError`) for aborts and signal timeouts.

**Methods** (all accept a trailing `opts?: { signal?: AbortSignal }`)

| Method | Endpoint | Returns |
|---|---|---|
| `listVaults()` | `GET /vaults` | `YieldsVault[]` (active vaults, by TVL) |
| `listFeaturedVaults()` | `GET /vaults/featured` | `YieldsVault[]` |
| `getVault(chainId, address)` | `GET /vaults/:chainId/:address` | `YieldsVault` |
| `getVaultAnalytics(chainId, address, params?)` | `GET .../analytics` | `YieldsVaultAnalytics`: series of `[timestamp, value]` per metric. Params: `{ since?, until?, metric?, days? }` (`days` mutually exclusive with `since`/`until`). |
| `getVaultRiskIndicators(chainId, address)` | `GET .../risk-indicators` | `YieldsVaultRiskIndicators`: `{ vaultId, chainId, address, indicators }`, each indicator `{ key, label, status, fetchedAt, data? }` with a vendor-specific `data`. |
| `getUserVaultBalance(chainId, address, wallet)` | `GET .../users/:wallet/balance` | `YieldsUserVaultBalance` |
| `getUserVaultActivity(chainId, address, wallet)` | `GET .../users/:wallet/activity` | `YieldsVaultUserActivity[]` |
| `getUserPositions(wallet)` | `GET /users/:wallet/positions` | `YieldsActiveVault[]` |
| `listBlockchains()` | `GET /blockchains` | `YieldsBlockchain[]` |
| `getRelatedVaults(chainId, address)` | `GET /vaults/related/:chainId/:address` | `YieldsVault[]` |
| `getProtocolInsights(blockchain, protocol, marketId?)` | `GET /vaults/protocol/...` | `YieldsProtocolInsights` |
| `getVaultMainInsights(chainId, address)` | `GET /vaults/:chainId/:address/main-insights` | `YieldsVaultMainInsights`: `YieldsProtocolInsights` plus the resolved `market` `{ blockchain, protocol, marketId? }`. Vaults without a DeFi Risk market get an empty `metric` and no `market`. |
| `getProtocolTvl(protocol)` | `GET /protocols/:protocol/tvl` | protocol TVL object |
| `getStrategyMetrics(positionId, params?)` | `GET /strategies/positions/:id/metric` | `YieldsStrategyMetrics` |
| `getStrategyAllocationDistribution(payload)` | `POST /strategies/positions/allocation-distribution/chart` | `YieldsAllocationDistribution`. A read query sent as `POST` because it takes a JSON body. |
| `getPulseMetadata()` / `getPulseNotifications(query?)` | `GET /pulse/...` | pulse metadata / notifications. |

**Helpers**: `toCaip2ChainId(id)` (legacy `'1'`/`'Solana'` to CAIP-2; non-EVM names match case-insensitively), `evmChainId(id)` (positive chain id from a lower-case `eip155:<n>` or a legacy numeric EVM id; `undefined` for non-EVM ids, including Solana's legacy `'1399811149'`, and anything else).

Response types are generated from the API's OpenAPI spec, so they list exactly the documented fields. Key ones: `YieldsVault` (`schemaVersion`, CAIP-2 `chainId`, `family`/`familyVersion` (selects the SDK adapter), `vendor`, `curator`, `distributor`, `contracts` keyed by role with `contracts.vault` as the vault's id, depositToken/receiptToken as `YieldsToken`, fees, `analytics`), `YieldsActiveVault` (adds `withPositions` and `userMetrics`), `YieldsUserVaultBalance` (live shares/USD/APY), `YieldsVaultUserActivity` (per-tx records), `YieldsBlockchain`, `YieldsVaultMainInsights`. The only open-ended maps, typed `{ [key: string]: … }`, are the per-token position amounts on vault records (`positionSize`, `positionSizeUsd`, `returns`, `returnsUsd`), most of the `getStrategyMetrics` response, and the pulse `policies`.

## Environment

The client reads no environment variables; pass `apiKey` and `baseUrl` yourself. The Sentora CLI and MCP server read `YIELDS_API_KEY` (or `SENTORA_API_KEY`) and `YIELDS_BASE_URL` (or `SENTORA_API_URL`) and pass them in.

## License

MIT. The LICENSE file ships in this package.
