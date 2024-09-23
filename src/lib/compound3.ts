import { type Hex } from '@api3/commons';
import { ethers } from 'ethers';

import {
  IComet__factory as ICometFactory,
  Compound3Liquidator__factory as Compound3LiquidatorFactory,
  type Compound3Liquidator,
} from '../../typechain-types';
import { type Api3Feed } from '../beacons';
import { prepareApi3Feeds } from '../beacons';
import { baseContractAddresses } from '../chain';
import { COMET_ADDRESS } from '../constants';

export const compound3Api3Feeds: Api3Feed[] = prepareApi3Feeds([
  {
    dapiName: ethers.encodeBytes32String('cbETH/ETH Exchange Rate') as Hex,
    proxyAddress: baseContractAddresses.api3OevCbethEthProxy,
    oevEnabled: true,
  },
  {
    dapiName: ethers.encodeBytes32String('ETH/USD') as Hex,
    proxyAddress: baseContractAddresses.api3OevEthUsdProxy,
    oevEnabled: true,
  },
  {
    dapiName: ethers.encodeBytes32String('wstETH/stETH Exchange Rate') as Hex,
    proxyAddress: baseContractAddresses.api3OevWstethStethProxy,
    oevEnabled: true,
  },
  {
    dapiName: ethers.encodeBytes32String('stETH/USD') as Hex,
    proxyAddress: baseContractAddresses.api3OevStethUsdProxy,
    oevEnabled: true,
  },
  {
    dapiName: ethers.encodeBytes32String('USDC/USD') as Hex,
    proxyAddress: baseContractAddresses.api3OevUsdcUsdProxy,
    oevEnabled: true,
  },
]);

export const createCompound3Connectors = (compound3LiquidatorAddress: string, baseProvider: ethers.JsonRpcProvider) => {
  return {
    usdcComet: ICometFactory.connect(COMET_ADDRESS, baseProvider),
    compound3Liquidator: Compound3LiquidatorFactory.connect(compound3LiquidatorAddress, baseProvider),
  };
};
export type Compound3Connectors = ReturnType<typeof createCompound3Connectors>;

export type GetAccountsDetails = Awaited<ReturnType<Compound3Liquidator['getAccountsDetails']>>;

export type Compound3PositionDetails = {
  position: string;
  borrowUsd: bigint;
  maxBorrowUsd: bigint;
  collateralUsd: bigint;
  isLiquidatable: boolean;
  loanToValue: number;
};
