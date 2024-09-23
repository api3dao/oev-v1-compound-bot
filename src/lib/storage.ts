import { type Hex } from '@api3/commons';
import { ethers } from 'ethers';
import { produce } from 'immer';

import { allPositions, lastBlock } from '../all-positions.json';
import { createBaseConnectors, type BaseConnectors } from '../chain';
import { env } from '../env';

import { createCompound3Connectors, type Compound3Connectors } from './compound3';

export type Compound3Position = string;

export interface Compound3BotStorage {
  allPositions: Compound3Position[];
  currentPositions: Compound3Position[];
  interestingPositions: Compound3Position[];
  targetChainLastBlock: number;
  currentlyLiquidatedPositions: Compound3Position[];
  dapiNameHashToDataFeedId: Record<Hex, Hex>;
  baseConnectors: BaseConnectors;
  compound3Connectors: Compound3Connectors;
}

let storage: Compound3BotStorage | null = null;

export const initializeStorage = () => {
  const wallet = new ethers.Wallet(env.HOT_WALLET_PRIVATE_KEY);
  const baseConnectors = createBaseConnectors(wallet, env.RPC_URL);

  storage = {
    allPositions,
    baseConnectors,
    compound3Connectors: createCompound3Connectors(env.LIQUIDATOR_CONTRACT_ADDRESS, baseConnectors.provider),
    currentPositions: [],
    currentlyLiquidatedPositions: [],
    dapiNameHashToDataFeedId: {},
    interestingPositions: [],
    targetChainLastBlock: lastBlock,
  };

  return storage;
};

export const getStorage = () => {
  if (!storage) throw new Error('Compound3 bot storage not initialized');

  return storage;
};

export const updateStorage = (updater: (draft: Compound3BotStorage) => void) => {
  storage = produce(getStorage(), updater);
};