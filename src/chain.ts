import { hardhatConfig } from '@api3/chains';
import {
  type AirseekerRegistry,
  AirseekerRegistry__factory as AirseekerRegistryFactory,
  type Api3ServerV1,
  Api3ServerV1__factory as Api3ServerV1Factory,
  computeApi3MarketAirseekerRegistryAddress,
} from '@api3/contracts';
import { ethers, type Wallet } from 'ethers';

import { type Multicall3, Multicall3__factory as Multicall3Factory } from '../typechain-types';

export const baseContractAddresses = {
  api3ServerV1: '0x709944a48cAf83535e43471680fDA4905FB3920a',
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
} as const;

const network = new ethers.Network('base', hardhatConfig.networks().base!.chainId);

export interface BaseConnectors {
  provider: ethers.JsonRpcProvider;
  api3ServerV1: Api3ServerV1;
  airseekerRegistry: AirseekerRegistry;
  wallet: Wallet;
  multicall3: Multicall3;
}
export const createBaseConnectors = (wallet: ethers.Wallet, rpcUrl: string): BaseConnectors => {
  const fetchRequest = new ethers.FetchRequest(rpcUrl);
  fetchRequest.timeout = 10_000; // NOTE: The default FetchRequest timeout is 300_000 ms
  const provider = new ethers.JsonRpcProvider(fetchRequest, network, {
    staticNetwork: network,
  });

  return {
    wallet: wallet.connect(provider),
    provider,
    multicall3: Multicall3Factory.connect(baseContractAddresses.multicall3, provider),
    api3ServerV1: Api3ServerV1Factory.connect(baseContractAddresses.api3ServerV1, provider),
    airseekerRegistry: AirseekerRegistryFactory.connect(
      computeApi3MarketAirseekerRegistryAddress(hardhatConfig.networks().base!.chainId),
      provider
    ),
  };
};
