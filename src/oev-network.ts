import { type OevAuctionHouse, OevAuctionHouse__factory as OevAuctionHouseFactory } from '@api3/contracts';
import { ethers, type Wallet } from 'ethers';

export const oevNetworkContractAddresses = {
  oevAuctionHouse: '0x34f13A5C0AD750d212267bcBc230c87AEFD35CC5',
} as const;

const network = new ethers.Network('oev-network', 4913);

export interface OevNetworkConnectors {
  oevAuctionHouse: OevAuctionHouse;
  provider: ethers.JsonRpcProvider;
  wallet: Wallet;
}
export const createOevNetworkConnectors = (wallet: ethers.Wallet, rpcUrl: string): OevNetworkConnectors => {
  const fetchRequest = new ethers.FetchRequest(rpcUrl);
  fetchRequest.timeout = 10_000; // NOTE: The default FetchRequest timeout is 300_000 ms
  const provider = new ethers.JsonRpcProvider(fetchRequest, network, {
    staticNetwork: network,
  });

  return {
    wallet: wallet.connect(provider),
    provider,
    oevAuctionHouse: OevAuctionHouseFactory.connect(oevNetworkContractAddresses.oevAuctionHouse, provider),
  };
};
