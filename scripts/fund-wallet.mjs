/**
 * Fund a wallet on the local anvil fork for manual testing:
 * transfers 10,000 USDC from an impersonated whale and sets 10 ETH for gas.
 *
 *   npm run fund-wallet -- 0xYourWalletAddress
 */
import { createPublicClient, createWalletClient, http, parseAbi, parseUnits, formatUnits } from 'viem';
import { mainnet } from 'viem/chains';

const RPC = process.env.FORK_RPC_URL ?? 'http://127.0.0.1:8545';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WHALES = [
  '0x37305B1cD40574E4C5Ce33f8e8306Be057fD7341', // Circle
  '0x28C6c06298d514Db089934071355E5743bf21d60', // Binance 14
  '0x55FE002aefF02F77364de339a1292923A15844B8', // Circle 2
];
const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address, uint256) returns (bool)',
]);

const target = process.argv[2];
if (!/^0x[0-9a-fA-F]{40}$/.test(target ?? '')) {
  console.error('Usage: npm run fund-wallet -- 0xAddress');
  process.exit(2);
}

const pc = createPublicClient({ chain: mainnet, transport: http(RPC) });
const rpc = (method, params) => pc.request({ method, params });

try {
  await rpc('anvil_impersonateAccount', [WHALES[0]]);
} catch {
  const origin = (() => { try { return new URL(RPC).origin; } catch { return '<invalid-url>'; } })();
  console.error(`Cannot impersonate — is anvil running at ${origin}?\nStart it with: anvil --fork-url $ETH_RPC_URL --chain-id 1`);
  process.exit(1);
}

let whale;
for (const w of WHALES) {
  const bal = await pc.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [w] });
  if (bal > parseUnits('100000', 6)) { whale = w; console.log(`whale: ${w} (${formatUnits(bal, 6)} USDC)`); break; }
}
if (!whale) { console.error('No funded whale found on this fork — update WHALES[].'); process.exit(1); }

await rpc('anvil_impersonateAccount', [whale]);
await rpc('anvil_setBalance', [whale, '0x8AC7230489E80000']);
const wc = createWalletClient({ account: whale, chain: mainnet, transport: http(RPC) });

const hash = await wc.writeContract({ address: USDC, abi: erc20, functionName: 'transfer', args: [target, parseUnits('10000', 6)] });
await pc.waitForTransactionReceipt({ hash });
await rpc('anvil_setBalance', [target, '0x8AC7230489E80000']);
console.log(`Funded ${target} with 10,000 USDC + 10 ETH on the fork.`);
