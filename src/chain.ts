import { hardhatConfig } from '@api3/chains';
import {
  type AirseekerRegistry,
  AirseekerRegistry__factory as AirseekerRegistryFactory,
  type Api3ServerV1,
  Api3ServerV1__factory as Api3ServerV1Factory,
  computeApi3MarketAirseekerRegistryAddress,
  type ExternalMulticallSimulator,
  ExternalMulticallSimulator__factory as ExternalMulticallSimulatorFactory,
} from '@api3/contracts';
import { ethers, type Wallet } from 'ethers';

import { type Multicall3, Multicall3__factory as Multicall3Factory } from '../typechain-types';

export const baseContractAddresses = {
  api3OevCbethEthProxy: '0x7583f6435cAD95bcF30C2dD7fDbfD3c5Ab58Ce4C',
  api3OevEthUsdProxy: '0x86313242dBfedD9C52733a0Ed384E917424A7436',
  api3OevWstethStethProxy: '0x3739c04CfE9d4750Bb40fc46904d592f3ed8EdEf',
  api3OevStethUsdProxy: '0x93d2D4Aae8143E2a067a54C8138Dc8054Ad79910',
  api3OevUsdcUsdProxy: '0x773f1a8E77Bd9e91a84bD80Bf35e67e4989D5C4C',
  api3ServerV1: '0x709944a48cAf83535e43471680fDA4905FB3920a',
  externalMulticallSimulator: '0xb45fe2838F47DCCEe00F635785EAF0c723F742E5',
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
} as const;

const network = new ethers.Network('base', hardhatConfig.networks().base!.chainId);

export interface BaseConnectors {
  provider: ethers.JsonRpcProvider;
  externalMulticallSimulator: ExternalMulticallSimulator;
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
    externalMulticallSimulator: ExternalMulticallSimulatorFactory.connect(
      baseContractAddresses.externalMulticallSimulator,
      provider
    ),
    api3ServerV1: Api3ServerV1Factory.connect(baseContractAddresses.api3ServerV1, provider),
    airseekerRegistry: AirseekerRegistryFactory.connect(
      computeApi3MarketAirseekerRegistryAddress(hardhatConfig.networks().base!.chainId),
      provider
    ),
  };
};
