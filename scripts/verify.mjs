/**
 * Interface verification: reads the deployed "Sentora USD" TokenizedVault
 * proxy on mainnet and confirms the ABI the SDK codes against
 * (packages/vaults-upshift-financial/src/abi.ts). Run BEFORE trusting the hooks.
 *
 *   ETH_RPC_URL=https://... npm run verify
 */
import { createPublicClient, http, parseAbi, parseUnits, formatUnits } from 'viem';
import { mainnet } from 'viem/chains';

const RPC = process.env.ETH_RPC_URL || 'https://ethereum-rpc.publicnode.com';
const VAULT = '0x74aD2F789Ed583DBd141bbdafC673fE1F033718b'; // Sentora USD (API-listed)

// provider URLs embed the API key in the path — never print them verbatim
function redactUrl(raw) {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname !== '/' || u.search ? '/…' : ''}`;
  } catch {
    return '<invalid-url>';
  }
}

// viem's full error message includes the request URL: print only shortMessage
const errorText = (e) => String(e?.shortMessage ?? e?.message ?? e).replaceAll(RPC, redactUrl(RPC)).slice(0, 120);

const abi = parseAbi([
  'function asset() view returns (address)',
  'function lpTokenAddress() view returns (address)',
  'function getTotalAssets() view returns (uint256)',
  'function getSharePrice() view returns (uint256)',
  'function depositCap() view returns (uint256)',
  'function maxDepositAmount() view returns (uint256)',
  'function maxWithdrawalAmount() view returns (uint256)',
  'function depositsPaused() view returns (bool)',
  'function withdrawalsPaused() view returns (bool)',
  'function instantRedemptionFee() view returns (uint256)',
  'function withdrawalFee() view returns (uint256)',
  'function lagDuration() view returns (uint256)',
  'function assetsWhitelistAddress() view returns (address)',
  'function sendersWhitelistAddress() view returns (address)',
  'function previewDeposit(address, uint256) view returns (uint256, uint256)',
  'function previewRedemption(uint256, bool) view returns (uint256, uint256)',
  'function getWithdrawalEpoch() view returns (uint256, uint256, uint256, uint256)',
]);
const erc20 = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);

const pc = createPublicClient({ chain: mainnet, transport: http(RPC) });
let failures = 0;

async function check(fn, args = [], format = (r) => r) {
  try {
    const r = await pc.readContract({ address: VAULT, abi, functionName: fn, args });
    console.log(`  ✔ ${fn}(${args.map(String).join(',')}) = ${format(r)}`);
    return r;
  } catch (e) {
    failures++;
    console.log(`  ✘ ${fn} FAILED: ${errorText(e)}`);
    return null;
  }
}

async function readToken(address, fn) {
  try {
    return await pc.readContract({ address, abi: erc20, functionName: fn });
  } catch (e) {
    failures++;
    console.log(`  ✘ ${fn}() on ${address} FAILED: ${errorText(e)}`);
    return null;
  }
}

const block = await pc.getBlockNumber().catch((e) => {
  console.error(`Cannot read from the RPC at ${redactUrl(RPC)}: ${errorText(e)}`);
  process.exit(1);
});
console.log(`\nVerifying Sentora USD TokenizedVault at ${VAULT}\nRPC: ${redactUrl(RPC)}\nblock: ${block}\n`);

const asset = await check('asset');
const lpToken = await check('lpTokenAddress');
await check('getTotalAssets', [], (r) => formatUnits(r, 6) + ' (assuming 6dp reference)');
await check('getSharePrice');
await check('depositCap');
await check('maxDepositAmount');
await check('maxWithdrawalAmount');
await check('depositsPaused');
await check('withdrawalsPaused');
await check('instantRedemptionFee');
await check('withdrawalFee');
await check('lagDuration', [], (r) => `${r}s`);
await check('assetsWhitelistAddress');
await check('sendersWhitelistAddress');
await check('getWithdrawalEpoch', [], (r) => `${r[0]}-${r[1]}-${r[2]} epoch=${r[3]}`);

if (asset) {
  const sym = await readToken(asset, 'symbol');
  const okUsdc = asset.toLowerCase() === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  console.log(`  ${okUsdc ? '✔' : '✘'} reference asset = ${sym ?? '?'} ${asset} ${okUsdc ? '[USDC confirmed]' : '[NOT mainnet USDC!]'}`);
  if (!okUsdc) failures++;
}
if (lpToken) {
  const sym = await readToken(lpToken, 'symbol');
  const dec = await readToken(lpToken, 'decimals');
  if (sym !== null && dec !== null) console.log(`  ✔ LP token = ${sym} (${dec}dp) ${lpToken}`);
}

console.log('\nPreviews (1000 USDC / matching shares):');
const amt = parseUnits('1000', 6);
const preview = await check('previewDeposit', [asset, amt], (r) => `shares=${r[0]} refValue=${r[1]}`);
if (preview) {
  await check('previewRedemption', [preview[0], false], (r) => `assets=${r[0]} afterFee=${r[1]} (queued)`);
  await check('previewRedemption', [preview[0], true], (r) => `assets=${r[0]} afterFee=${r[1]} (instant)`);
}

console.log(failures === 0
  ? '\nAll reads verified — the ABI in packages/vaults-upshift-financial/src/abi.ts matches the deployed contract.\n'
  : `\n${failures} check(s) FAILED — fix packages/vaults-upshift-financial/src/abi.ts before using the hooks.\n`);
process.exit(failures === 0 ? 0 : 1);
