/**
 * BoringVault (Veda architecture) ABI — user-facing surface only.
 * Source: Se7en-Seas/boring-vault and Veda-Labs/boring-vault (4-arg referral
 * deposit) contracts.
 *
 * Topology the integrator must know:
 *  - BoringVault      = the ERC-20 share token AND the deposit approval target
 *  - Teller           = the deposit entrypoint (deposit / depositWithPermit)
 *  - Accountant       = pushed exchange rate (getRateInQuoteSafe); can pause
 *  - BoringOnChainQueue = async withdrawals; approve SHARES to the queue
 *  - RolesAuthority   = every user fn is requiresAuth → preflight via canCall
 */

export const boringVaultAbi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  // topology discovery: Solmate Auth authority + before-transfer hook (the teller, when share lock is wired)
  { type: 'function', name: 'authority', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'hook', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

export const tellerAbi = [
  {
    type: 'function', name: 'deposit', stateMutability: 'payable',
    inputs: [
      { name: 'depositAsset', type: 'address' },
      { name: 'depositAmount', type: 'uint256' },
      { name: 'minimumMint', type: 'uint256' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
  {
    type: 'function', name: 'depositWithPermit', stateMutability: 'nonpayable',
    inputs: [
      { name: 'depositAsset', type: 'address' },
      { name: 'depositAmount', type: 'uint256' },
      { name: 'minimumMint', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
  { type: 'function', name: 'isPaused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  {
    type: 'function', name: 'assetData', stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      { name: 'allowDeposits', type: 'bool' },
      { name: 'allowWithdraws', type: 'bool' },
      { name: 'sharePremium', type: 'uint16' },
    ],
  },
  { type: 'function', name: 'shareUnlockTime', stateMutability: 'view', inputs: [{ name: 'user', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'shareLockPeriod', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'vault', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'accountant', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

export const accountantAbi = [
  { type: 'function', name: 'getRate', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getRateInQuoteSafe', stateMutability: 'view', inputs: [{ name: 'quote', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

export const boringQueueAbi = [
  {
    type: 'function', name: 'requestOnChainWithdraw', stateMutability: 'nonpayable',
    inputs: [
      { name: 'assetOut', type: 'address' },
      { name: 'amountOfShares', type: 'uint128' },
      { name: 'discount', type: 'uint16' },
      { name: 'secondsToDeadline', type: 'uint24' },
    ],
    outputs: [{ name: 'requestId', type: 'bytes32' }],
  },
  {
    type: 'function', name: 'cancelOnChainWithdraw', stateMutability: 'nonpayable',
    inputs: [{
      name: 'request', type: 'tuple', components: [
        { name: 'nonce', type: 'uint96' },
        { name: 'user', type: 'address' },
        { name: 'assetOut', type: 'address' },
        { name: 'amountOfShares', type: 'uint128' },
        { name: 'amountOfAssets', type: 'uint128' },
        { name: 'creationTime', type: 'uint40' },
        { name: 'secondsToMaturity', type: 'uint24' },
        { name: 'secondsToDeadline', type: 'uint24' },
      ],
    }],
    outputs: [{ name: 'requestId', type: 'bytes32' }],
  },
  {
    type: 'function', name: 'withdrawAssets', stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      { name: 'allowWithdraws', type: 'bool' },
      { name: 'secondsToMaturity', type: 'uint24' },
      { name: 'minimumSecondsToDeadline', type: 'uint24' },
      { name: 'minDiscount', type: 'uint16' },
      { name: 'maxDiscount', type: 'uint16' },
      { name: 'minimumShares', type: 'uint96' },
    ],
  },
  {
    type: 'function', name: 'previewAssetsOut', stateMutability: 'view',
    inputs: [
      { name: 'assetOut', type: 'address' },
      { name: 'amountOfShares', type: 'uint128' },
      { name: 'discount', type: 'uint16' },
    ],
    outputs: [{ name: 'amountOfAssets128', type: 'uint128' }],
  },
  { type: 'function', name: 'getRequestIds', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32[]' }] },
  { type: 'function', name: 'isPaused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'boringVault', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'authority', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'event', name: 'OnChainWithdrawRequested',
    inputs: [
      { name: 'requestId', type: 'bytes32', indexed: true },
      { name: 'user', type: 'address', indexed: true },
      { name: 'assetOut', type: 'address', indexed: true },
      { name: 'nonce', type: 'uint96', indexed: false },
      { name: 'amountOfShares', type: 'uint128', indexed: false },
      { name: 'amountOfAssets', type: 'uint128', indexed: false },
      { name: 'creationTime', type: 'uint40', indexed: false },
      { name: 'secondsToMaturity', type: 'uint24', indexed: false },
      { name: 'secondsToDeadline', type: 'uint24', indexed: false },
    ],
  },
] as const;

export const rolesAuthorityAbi = [
  {
    type: 'function', name: 'canCall', stateMutability: 'view',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'target', type: 'address' },
      { name: 'functionSig', type: 'bytes4' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function', name: 'isCapabilityPublic', stateMutability: 'view',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'functionSig', type: 'bytes4' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function', name: 'getRolesWithCapability', stateMutability: 'view',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'functionSig', type: 'bytes4' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
  // queue discovery: every grantee/target ever wired shows up in these events
  {
    type: 'event', name: 'RoleCapabilityUpdated',
    inputs: [
      { name: 'role', type: 'uint8', indexed: true },
      { name: 'target', type: 'address', indexed: true },
      { name: 'functionSig', type: 'bytes4', indexed: true },
      { name: 'enabled', type: 'bool', indexed: false },
    ],
  },
  {
    type: 'event', name: 'PublicCapabilityUpdated',
    inputs: [
      { name: 'target', type: 'address', indexed: true },
      { name: 'functionSig', type: 'bytes4', indexed: true },
      { name: 'enabled', type: 'bool', indexed: false },
    ],
  },
] as const;

export const erc20Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;

/** bytes4 selector of Teller.deposit(address,uint256,uint256) — for RolesAuthority.canCall preflight */
export const TELLER_DEPOSIT_SELECTOR = '0x0efe6a8b' as const;

/** bytes4 selector of BoringOnChainQueue.requestOnChainWithdraw(address,uint128,uint16,uint24) */
export const QUEUE_REQUEST_WITHDRAW_SELECTOR = '0x6bb3b476' as const;

/**
 * Newer teller generations (e.g. LayerZeroTeller on Ink) replace deposit with
 * deposit(address depositAsset, uint256 depositAmount, uint256 minimumMint,
 * address referralAddress) — shares still mint to msg.sender; the 4th arg is
 * a referral tag only.
 */
export const TELLER_DEPOSIT_SELECTOR_V2 = '0x8b6099db' as const;

export const tellerDepositV2Abi = [
  {
    type: 'function', name: 'deposit', stateMutability: 'payable',
    inputs: [
      { name: 'depositAsset', type: 'address' },
      { name: 'depositAmount', type: 'uint256' },
      { name: 'minimumMint', type: 'uint256' },
      { name: 'referralAddress', type: 'address' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
] as const;
