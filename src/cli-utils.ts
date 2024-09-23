import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ethers } from 'ethers';
import { format } from 'prettier';

import { Compound3Liquidator__factory as Compound3LiquidatorFactory } from '../typechain-types';

import { COMET_ADDRESS } from './constants';
import { compound3Api3Feeds } from './lib/compound3';
import {
  ALL_POSITIONS_FILE_PATH,
  POSITIONS_TO_WATCH_FILE_PATH,
  filterPositions,
  getAllPositions,
} from './lib/positions';
import { initializeStorage } from './lib/storage';
import { logger } from './logger';

const writeDataToJsonFile = async (filePath: string, data: any) => {
  const stringifiedData = JSON.stringify(data, null, 2);
  const prettierOptions: any = JSON.parse(readFileSync(join(__dirname, '../.prettierrc'), 'utf8'));
  const output = await format(stringifiedData, { parser: 'json', ...prettierOptions });

  writeFileSync(filePath, output);
};

export const defaultAllPositions = { allPositions: [], lastBlock: 0 };

const preparePositionsToWatch = async (resetAllPositions: boolean) => {
  const { allPositions, lastBlock } = await getAllPositions(resetAllPositions);
  const { interestingPositions, currentPositions } = await filterPositions(allPositions);
  logger.info('Filtered borrowers close to liquidation', {
    interestingPositionsCount: interestingPositions.length,
    currentPositionsCount: currentPositions.length,
  });

  writeDataToJsonFile(ALL_POSITIONS_FILE_PATH, { allPositions, lastBlock });
  writeDataToJsonFile(POSITIONS_TO_WATCH_FILE_PATH, { interestingPositions, currentPositions });
};

export const runCliUtils = async () => {
  const { baseConnectors } = initializeStorage(compound3Api3Feeds);

  // Expected usage is to call this script with the type of command to perform.
  const command = process.argv[2];
  switch (command) {
    case 'deploy': {
      logger.info('Deploying new Compound3Liquidator contract');

      const deployTx = await new Compound3LiquidatorFactory(baseConnectors.wallet).deploy(
        ethers.ZeroAddress,
        COMET_ADDRESS
      );
      await deployTx.deploymentTransaction()?.wait(1);
      logger.info('Deployed Compound3Liquidator', {
        txHash: deployTx.deploymentTransaction()!.hash,
        address: await deployTx.getAddress(),
      });
      return;
    }
    case 'prepare-positions-to-watch': {
      await preparePositionsToWatch(false);
      return;
    }
    case 'reset-positions-to-watch': {
      await preparePositionsToWatch(true);
      return;
    }
    default: {
      logger.error('Unknown action', { command });
      return;
    }
  }
};
