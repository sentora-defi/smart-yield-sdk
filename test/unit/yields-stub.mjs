import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { parseAbiItem } from 'viem';

export const STUB_VAULTS = [
  {
    schemaVersion: 1, chainId: 'eip155:1', name: 'Morpho Sentora PYUSD Main V2', status: 'active', category: 'stablecoins', type: 'direct',
    family: 'morpho', familyVersion: 1, vendor: 'morpho', curator: 'sentora', featured: true,
    contracts: { vault: '0xb576765fB15505433aF24FEe2c0325895C559FB2' },
    depositToken: { chainId: 'eip155:1', address: '0x6c3ea9036406852006290770BEdFcAbA0e23A0e8', decimals: 6, symbol: 'PYUSD' },
  },
  {
    schemaVersion: 1, chainId: 'eip155:1', name: 'Sentora USD', status: 'active', category: 'stablecoins', type: 'smart_vault',
    family: 'upshift_evm', familyVersion: 1, vendor: 'upshift', curator: 'sentora',
    contracts: { vault: '0x74aD2F789Ed583DBd141bbdafC673fE1F033718b', receiptToken: '0xe8aA1A9eC6b9BC455D8f33E4BDC685dedFf82407' },
  },
  {
    schemaVersion: 1, chainId: 'eip155:57073', name: 'Advanced Strategies BTC', status: 'active', category: 'bitcoin', type: 'smart_vault',
    family: 'boring', familyVersion: 1, vendor: 'veda', curator: 'sentora', distributor: 'kraken',
    contracts: {
      vault: '0x7dee0120739b7ec048b469939efb178adbbb19b2',
      teller: '0x498b6baA9Fb4530570Ec06aEa343162DbF32604B',
      accountant: '0x4Bb6C416a00561ad6657110b76552c42d55Ff1d6',
      queue: '0x5F210D9C163E5F1D96Fd880B0178c3239fef89fb',
      rolesAuthority: '0x6f80D918aAc92f4855e7e77e4AeE0C3D6e8153ee',
    },
    depositToken: { chainId: 'eip155:57073', address: '0x000000000000000000000000000000000000bEEF', decimals: 8, symbol: 'kBTC' },
  },
  {
    schemaVersion: 1, chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', name: 'Kamino Sentora PYUSD', status: 'active', category: 'stablecoins', type: 'direct',
    family: 'kamino', familyVersion: 1, vendor: 'kamino', curator: 'sentora',
    contracts: { vault: 'A2wsxhA7pF4B2UKVfXocb6TAAP9ipfPJam6oMKgDE5BK', receiptToken: 'DCqyVY1SFCwq8unnexv9pjujVAC7jsmjfoUWBrNLvbY' },
  },
];

export const STUB_BLOCKCHAINS = [
  { chainId: 'eip155:1', slug: 'ethereum', name: 'Ethereum', symbol: 'ETH', explorerUrl: 'https://etherscan.io' },
  { chainId: 'eip155:57073', slug: 'ink', name: 'Ink', symbol: 'ETH', explorerUrl: 'https://explorer.inkonchain.com' },
  { chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', slug: 'solana', name: 'Solana', symbol: 'SOL', explorerUrl: 'https://solscan.io' },
];

export const STUB_WALLET = '0x000000000000000000000000000000000000dEaD';

export const STUB_ANALYTICS = (() => {
  const day = 86_400_000;
  const end = Date.UTC(2026, 9, 7);
  const ts = [4, 3, 2, 1, 0].map((n) => end - n * day);
  const series = (values) => ts.map((t, i) => [t, values[i]]);
  return {
    tvl: series([1000, 1100, 1050, 1200, 1300]),
    tvlUsd: series([1001, 1101, 1051, 1201, 1301]),
    apy: series([0.05, 0.051, 0.049, 0.052, 0.053]),
    apy7d: series([0.05, 0.05, 0.05, 0.051, 0.051]),
    apy30d: series([0.048, 0.048, 0.049, 0.049, 0.05]),
  };
})();

const SERVER = `
const { createServer } = await import('node:http');
const { rpcHandler, jsonRpcListener } = await import(process.env.STUB_FAKES);
const vaults = JSON.parse(process.env.STUB_BODY);
const blockchains = JSON.parse(process.env.STUB_BLOCKCHAINS);
const routes = JSON.parse(process.env.STUB_ROUTES);
const code = JSON.parse(process.env.STUB_CODE);
const rpc = rpcHandler(code.reads, {
  abi: code.abi, deployed: code.deployed, chainId: Number(process.env.STUB_CHAIN_ID),
  missingFunction: 'empty', missingAddress: 'error',
});
const analytics = JSON.parse(process.env.STUB_ANALYTICS);
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const appError = (res, status, message) => send(res, status, { hasError: true, status, message, errors: [{ message }] });
const caip2 = (id) => /^\\d+$/.test(id) ? 'eip155:' + id : id;
const findVault = (chain, address) => Array.isArray(vaults) && vaults.find((v) =>
  v && typeof v === 'object' && v.chainId === caip2(chain)
  && typeof v.contracts?.vault === 'string' && v.contracts.vault.toLowerCase() === address.toLowerCase());
const vaultRoute = (res, v, rest, url) => {
  if (rest === '') return send(res, 200, v);
  if (rest === '/main-insights') {
    if (v.type !== 'direct') return send(res, 200, { metric: {} });
    const slug = blockchains.find((b) => b.chainId === v.chainId)?.slug;
    return send(res, 200, {
      metric: { totalSupply: '412345678.123456', totalDebts: '301234567.654321', totalSupplyUsd: '412300000.5', totalDebtsUsd: '301200000.25', lastMetricDate: '2026-10-07' },
      market: { blockchain: slug, protocol: v.vendor, ...(v.marketIds?.length === 1 && { marketId: v.marketIds[0] }) },
    });
  }
  if (rest === '/analytics') {
    const q = url.searchParams;
    if (q.has('days') && (q.has('since') || q.has('until'))) return appError(res, 400, "Either use 'days' or 'since'/'until', but not both.");
    const keys = { tvl: 'tvl', tvl_usd: 'tvlUsd', apy: 'apy', apy7d: 'apy7d', apy30d: 'apy30d' };
    const wanted = q.getAll('metric');
    const out = {};
    for (const [name, key] of Object.entries(keys)) {
      if (wanted.length && !wanted.includes(name)) continue;
      let s = analytics[key];
      if (q.has('days')) s = s.slice(-Number(q.get('days')));
      if (q.has('since')) s = s.filter(([t]) => t >= Date.parse(q.get('since')));
      if (q.has('until')) s = s.filter(([t]) => t <= Date.parse(q.get('until')));
      out[key] = s;
    }
    return send(res, 200, out);
  }
  if (rest === '/risk-indicators') {
    return send(res, 200, {
      vaultId: 42, chainId: v.chainId, address: v.contracts.vault,
      indicators: [
        { key: 'liquidity', label: 'Liquidity', status: 'ok', fetchedAt: '2026-10-07T12:00:00.000Z', data: { availableLiquidityUsd: 1250000, utilization: 0.81 } },
        { key: 'oracle', label: 'Oracle', status: 'error', fetchedAt: '2026-10-07T12:00:00.000Z', data: null },
      ],
    });
  }
  const user = /^\\/users\\/([^/]+)\\/(balance|activity)$/.exec(rest);
  if (user && user[2] === 'balance') {
    return send(res, 200, {
      vaultId: 42, liveSharesRaw: '1500000000', liveSharesFormatted: 1500, livePriceUsd: 1.0213,
      liveBalanceUsd: 1531.95, liveBalanceInKind: 1531.95, apy: '0.0512', apy30d: '0.0498',
    });
  }
  if (user && user[2] === 'activity') {
    const item = (type, n) => ({
      id: 'ACTIVITY#2026-10-0' + n + '#0xabc' + n, chainId: v.chainId, userAddress: decodeURIComponent(user[1]), vaultAddress: v.contracts.vault,
      assetAddress: v.depositToken?.address ?? v.contracts.vault, type, amountRaw: '1000000000', sharesRaw: '979000000',
      txHash: '0x' + String(n).repeat(64), blockNumber: 20000000 + n, timestamp: '2026-10-0' + n + 'T10:00:00.000Z', status: 'COMPLETED',
    });
    return send(res, 200, [item('DEPOSIT', 1), item('WITHDRAW_REQUEST', 2)]);
  }
  return appError(res, 404, 'not found');
};
createServer(jsonRpcListener(rpc, (req, res) => {
  if (Object.hasOwn(routes, req.url)) {
    const r = routes[req.url];
    if (typeof r.text === 'string') {
      res.writeHead(r.status, { 'content-type': 'text/html' });
      return res.end(r.text);
    }
    return send(res, r.status, r.body);
  }
  const url = new URL(req.url, 'http://stub');
  if (url.pathname === '/vaults') return send(res, 200, vaults);
  if (url.pathname === '/blockchains') return send(res, 200, blockchains);
  const positions = /^\\/users\\/([^/]+)\\/positions$/.exec(url.pathname);
  if (positions) {
    const held = (Array.isArray(vaults) ? vaults : []).filter((v) => v && v.type === 'direct');
    return send(res, 200, held.map((v, i) => ({
      ...v, withPositions: i === 0,
      userMetrics: i === 0 ? { dbSharesRaw: '1500000000', dbSharesFormatted: 1500, dbBalanceInKind: 1531.95, dbBalanceUsd: 1531.95, historicalDepositedUsd: 1500 } : null,
    })));
  }
  const m = /^\\/vaults\\/([^/]+)\\/([^/]+)(.*)$/.exec(url.pathname);
  if (m) {
    const chain = decodeURIComponent(m[1]);
    const address = decodeURIComponent(m[2]);
    const hit = findVault(chain, address);
    if (hit) return vaultRoute(res, hit, m[3], url);
    return appError(res, 404, 'Vault with chainId ' + caip2(chain) + ' and address ' + address + ' not found');
  }
  appError(res, 404, 'not found');
})).listen(0, '127.0.0.1', function () { process.stdout.write(this.address().port + '\\n'); });
`;

const STUB_ADDRESS = '0x' + '11'.repeat(20);

// Listed getters answer with an address and other calls to that address return empty data; unlisted addresses get a JSON-RPC error.
function codeEnv(code) {
  const abi = [];
  const reads = {};
  for (const [address, getters] of Object.entries(code)) {
    for (const g of getters) {
      const item = parseAbiItem(`function ${g} view returns (address)`);
      abi.push(item);
      reads[`${address.toLowerCase()}.${item.name}`] = STUB_ADDRESS;
    }
  }
  return { abi, reads, deployed: Object.keys(code) };
}

/** The CLI runs under spawnSync, which blocks this process's event loop, so the stub lives in its own process. */
export async function startYieldsStub(vaults = STUB_VAULTS, { chainId = 57073, routes = {}, code = {} } = {}) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', SERVER], {
    env: {
      ...process.env,
      STUB_FAKES: new URL('./fakes.mjs', import.meta.url).href,
      STUB_BODY: JSON.stringify(vaults),
      STUB_BLOCKCHAINS: JSON.stringify(STUB_BLOCKCHAINS),
      STUB_ROUTES: JSON.stringify(routes),
      STUB_CODE: JSON.stringify(codeEnv(code)),
      STUB_ANALYTICS: JSON.stringify(STUB_ANALYTICS),
      STUB_CHAIN_ID: String(chainId),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await Promise.race([
    once(child.stdout, 'data').then(([chunk]) => String(chunk).trim()),
    once(child, 'exit').then(([code]) => { throw new Error(`yields stub exited with code ${code} before listening`); }),
  ]);
  return { url: `http://127.0.0.1:${port}`, close: () => child.kill() };
}
