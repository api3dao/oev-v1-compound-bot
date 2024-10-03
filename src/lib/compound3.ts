import { type ethers } from 'ethers';

import {
  IComet__factory as ICometFactory,
  Compound3Liquidator__factory as Compound3LiquidatorFactory,
} from '../../typechain-types';
import { COMET_ADDRESS } from '../constants';

export const createCompound3Connectors = (compound3LiquidatorAddress: string, baseProvider: ethers.JsonRpcProvider) => {
  return {
    usdcComet: ICometFactory.connect(COMET_ADDRESS, baseProvider),
    compound3Liquidator: Compound3LiquidatorFactory.connect(compound3LiquidatorAddress, baseProvider),
  };
};
export type Compound3Connectors = ReturnType<typeof createCompound3Connectors>;

export type Compound3PositionDetails = {
  position: string;
  borrowUsd: bigint;
  maxBorrowUsd: bigint;
  collateralUsd: bigint;
  isLiquidatable: boolean;
  loanToValue: number;
};
