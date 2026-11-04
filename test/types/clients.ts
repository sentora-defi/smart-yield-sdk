import { createPublicClient, createWalletClient, http, publicActions, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, ink, mainnet, zksync } from 'viem/chains';
import * as boring from '@sentora/vaults-boring';
import * as morpho from '@sentora/vaults-morpho';
import * as upshift from '@sentora/vaults-upshift-financial';

const addr: Address = '0x0000000000000000000000000000000000000001';
const cfg: boring.BoringVaultConfig = {
  vault: addr, teller: addr, accountant: addr, queue: addr, rolesAuthority: addr, chainId: 1,
};
const account = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000001');
const transport = http('http://127.0.0.1:1');

const clients = [
  createPublicClient({ transport }),
  createPublicClient({ chain: mainnet, transport }),
  createPublicClient({ chain: ink, transport }),
  createPublicClient({ chain: base, transport }),
  createPublicClient({ chain: zksync, transport }),
  createWalletClient({ account, chain: ink, transport }).extend(publicActions),
  createWalletClient({ account, chain: zksync, transport }).extend(publicActions),
] as const;

const wallets = [
  createWalletClient({ account, transport }),
  createWalletClient({ account, chain: mainnet, transport }),
  createWalletClient({ account, chain: ink, transport }),
  createWalletClient({ account, chain: base, transport }),
  createWalletClient({ account, chain: zksync, transport }),
] as const;

export function compiles(): void {
  for (const pc of clients) {
    void morpho.getPosition(pc, addr, addr, addr);
    void morpho.planDeposit(pc, addr, { assets: 1n, owner: addr });
    void boring.discoverConfig(pc, addr);
    void boring.planRequestWithdraw(pc, cfg, { assetOut: addr, shares: 1n, owner: addr });
    void upshift.getWithdrawalEpoch(pc, addr);
    void upshift.planClaim(pc, addr, { date: { year: 2026, month: 1, day: 1 }, receiver: addr, owner: addr });
    for (const wc of wallets) {
      void morpho.deposit(pc, wc, addr, 1n, addr);
      void boring.deposit(pc, wc, cfg, addr, 1n, 1n, 'v2');
      void boring.requestWithdraw(pc, wc, cfg, addr, 1n, 1, 3600);
      void upshift.claim(pc, wc, addr, { year: 2026, month: 1, day: 1 }, addr);
    }
  }
}
