import { hardhatConfig } from '@api3/chains';
import {
  type AirseekerRegistry,
  AirseekerRegistry__factory as AirseekerRegistryFactory,
  type Api3ServerV1,
  Api3ServerV1__factory as Api3ServerV1Factory,
  computeApi3MarketAirseekerRegistryAddress,
} from '@api3/contracts';
import { ethers, type Wallet } from 'ethers';

import {
  type IApi3ServerV1OevExtension,
  IApi3ServerV1OevExtension__factory as IApi3ServerV1OevExtensionFactory,
  type Multicall3,
  Multicall3__factory as Multicall3Factory,
} from '../typechain-types';

export const baseContractAddresses = {
  api3OevCbethEthProxy: '0x5bbeEE12b8779E1809f52441a9c2de6a3eD3dEA5',
  api3OevEthUsdProxy: '0x06314AbEEA3f6A308741b1Df209f55edB58354AB',
  api3OevWstethStethProxy: '0x63e3509F3Dc9f055441369A9d54B04D6FeE4adaf',
  api3OevStethUsdProxy: '0x75e5A34dad31D1DB19dBeC6fFB82EbBee5e0b9ab',
  api3OevUsdcUsdProxy: '0x6FBea86770975081D935456FAFfAB88524a0d1EF',
  api3ServerV1: '0x709944a48cAf83535e43471680fDA4905FB3920a',
  api3ServerV1OevExtension: '0x6a6F4b90ac94Df292fAe521b24b94cE8E58EB91e',
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
} as const;

const network = new ethers.Network('base', hardhatConfig.networks().base!.chainId);

export interface BaseConnectors {
  provider: ethers.JsonRpcProvider;
  api3ServerV1: Api3ServerV1;
  api3ServerV1OevExtension: IApi3ServerV1OevExtension;
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
    api3ServerV1OevExtension: IApi3ServerV1OevExtensionFactory.connect(
      baseContractAddresses.api3ServerV1OevExtension,
      provider
    ),
    airseekerRegistry: AirseekerRegistryFactory.connect(
      computeApi3MarketAirseekerRegistryAddress(hardhatConfig.networks().base!.chainId),
      provider
    ),
  };
};
