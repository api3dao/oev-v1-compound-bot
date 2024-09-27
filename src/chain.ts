import {
  type AirseekerRegistry,
  AirseekerRegistry__factory as AirseekerRegistryFactory,
  type Api3ServerV1,
  Api3ServerV1__factory as Api3ServerV1Factory,
  type Api3ServerV1OevExtension,
  Api3ServerV1OevExtension__factory as Api3ServerV1OevExtensionFactory,
  deploymentAddresses,
} from '@api3/contracts';
import { ethers, type Wallet } from 'ethers';

import { type Multicall3, Multicall3__factory as Multicall3Factory } from '../typechain-types';

export const baseContractAddresses = {
  api3OevCbethEthProxy: '0xe653cca9f7dF2E31ce00e2393916DC662885a289',
  api3OevEthUsdProxy: '0x5b0cf2b36a65a6BB085D501B971e4c102B9Cd473',
  api3OevWstethStethProxy: '0xa7C64E79eeee1A4c9B6Ea2976Fa37c276BB1A6cD',
  api3OevStethUsdProxy: '0xAD806B3BD9cb89C5021CB4f2102258e3DfbB3BD4',
  api3OevUsdcUsdProxy: '0xD3C586Eec1C6C3eC41D276a23944dea080eDCf7f',
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
} as const;

const chainId = 8453;
const network = new ethers.Network('base', chainId);

export interface BaseConnectors {
  provider: ethers.JsonRpcProvider;
  api3ServerV1: Api3ServerV1;
  api3ServerV1OevExtension: Api3ServerV1OevExtension;
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
    api3ServerV1: Api3ServerV1Factory.connect(deploymentAddresses.Api3ServerV1[chainId], provider),
    api3ServerV1OevExtension: Api3ServerV1OevExtensionFactory.connect(
      deploymentAddresses.Api3ServerV1OevExtension[chainId],
      provider
    ),
    airseekerRegistry: AirseekerRegistryFactory.connect(deploymentAddresses.AirseekerRegistry[chainId], provider),
  };
};
