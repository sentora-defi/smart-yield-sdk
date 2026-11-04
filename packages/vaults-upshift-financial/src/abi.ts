/**
 * ABI subset for Upshift Financial "TokenizedVault" + "BridgeableReceiptToken",
 * transcribed from the VERIFIED implementations behind the mainnet proxies
 * (impl 0x4EAc314b… and 0x3369f683…, Blockscout-verified source).
 *
 * Architecture: the vault (API `address`) is the entry contract — deposits pull
 * `assetIn` from the sender and MINT a separate LP token (`lpTokenAddress`,
 * the API `receiptToken`). Queued redemptions transferFrom LP shares into the
 * vault (allowance required); instant redemptions burn directly (no allowance).
 */
import { parseAbi } from 'viem';

export const tokenizedVaultAbi = parseAbi([
  // topology + pricing
  'function asset() view returns (address)',
  'function lpTokenAddress() view returns (address)',
  'function getTotalAssets() view returns (uint256)',
  'function getSharePrice() view returns (uint256)',
  // limits + state
  'function depositCap() view returns (uint256)',
  'function maxDepositAmount() view returns (uint256)',
  'function maxWithdrawalAmount() view returns (uint256)',
  'function depositsPaused() view returns (bool)',
  'function withdrawalsPaused() view returns (bool)',
  'function instantRedemptionFee() view returns (uint256)',
  'function withdrawalFee() view returns (uint256)',
  'function lagDuration() view returns (uint256)',
  // gates
  'function assetsWhitelistAddress() view returns (address)',
  'function sendersWhitelistAddress() view returns (address)',
  'function operatorAddress() view returns (address)',
  'function owner() view returns (address)',
  // previews
  'function previewDeposit(address assetIn, uint256 amountIn) view returns (uint256 shares, uint256 amountInReferenceTokens)',
  'function previewRedemption(uint256 shares, bool isInstant) view returns (uint256 assetsAmount, uint256 assetsAfterFee)',
  // epochs
  'function getWithdrawalEpoch() view returns (uint256 year, uint256 month, uint256 day, uint256 claimableEpoch)',
  'function getScheduledTransactionsByDate(uint256 year, uint256 month, uint256 day) view returns (uint256 totalTransactions, uint256 executionEpoch)',
  'function getBurnableAmountByReceiver(uint256 year, uint256 month, uint256 day, address receiverAddr) view returns (uint256)',
  // writes
  'function deposit(address assetIn, uint256 amountIn, address receiverAddr) returns (uint256 shares)',
  'function requestRedeem(uint256 shares, address receiverAddr) returns (uint256 claimableEpoch, uint256 year, uint256 month, uint256 day)',
  'function instantRedeem(uint256 shares, address receiverAddr)',
  'function claim(uint256 year, uint256 month, uint256 day, address receiverAddr) returns (uint256, uint256)',
]);

export const whitelistAbi = parseAbi([
  'function isWhitelisted(address addr) view returns (bool)',
  'function getWhitelistedAssets() view returns (address[])',
]);

export const erc20Abi = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
]);
