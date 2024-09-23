import { readFileSync } from 'node:fs';

import { runInLoop } from '@api3/commons';
import { go, goSync } from '@api3/promise-utils';
import { difference, noop } from 'lodash';

import { LIQUIDATION_HARD_TIMEOUT_MS } from './constants';
import { env } from './env';
import { findLiquidatablePositions, liquidatePositions } from './lib/oev-liquidation';
import { fetchPositionsChunk, filterPositions, POSITIONS_TO_WATCH_FILE_PATH } from './lib/positions';
import { type Compound3Position, getStorage, initializeStorage, updateStorage } from './lib/storage';
import { logger } from './logger';
import { createRunInLoopOptions, fetchPositions, mergePositions } from './utils';

interface FilteredPositions {
  currentPositions: Compound3Position[];
  interestingPositions: Compound3Position[];
}

// eslint-disable-next-line functional/no-classes
export class Compound3Bot {
  constructor() {}

  async initializePositions() {
    logger.info('Initializing positions');

    const now = Date.now();
    const { allPositions: storedPositions } = getStorage();
    const currentBlockNumber = await this.fetchTargetChainCurrentBlockNumber();
    const newPositions = await this.fetchNewPositions(currentBlockNumber);
    const allPositions = mergePositions(storedPositions, newPositions);

    // The positions file is only available during development and has precedence.
    const goFromFile = goSync(() => {
      return JSON.parse(readFileSync(POSITIONS_TO_WATCH_FILE_PATH, 'utf8')) as FilteredPositions;
    });

    const { currentPositions, interestingPositions } = goFromFile.success
      ? goFromFile.data
      : await filterPositions(allPositions);

    logger.info('Watched positions', {
      allPositions: allPositions.length,
      currentPositions: currentPositions.length,
      interestingPositions: interestingPositions.length,
      elapsedMs: Date.now() - now,
    });
    updateStorage((draft) => {
      draft.allPositions = allPositions;
      draft.currentPositions = currentPositions;
      draft.interestingPositions = interestingPositions;
      draft.targetChainLastBlock = currentBlockNumber;
    });

    return { shouldContinueRunning: false };
  }

  async initialize() {
    initializeStorage();

    // Initialize the target chain (in case of failure retry indefinitely).
    await runInLoop(
      this.initializePositions.bind(this),
      createRunInLoopOptions(
        'initialize-target-chain',
        env.INITIALIZE_TARGET_CHAIN_TIMEOUT_MS,
        env.RUN_IN_LOOP_MAX_WAIT_TIME_PERCENTAGE,
        0
      )
    );
  }

  getPositionDifference(existingPositions: Compound3Position[], newPositions: Compound3Position[]) {
    const addedPositions = difference(newPositions, existingPositions);
    const discardedPositions = difference(existingPositions, newPositions);
    return { addedPositions, discardedPositions };
  }

  async fetchPositions(startBlockNumber: number, endBlockNumber: number) {
    return fetchPositions(
      startBlockNumber,
      endBlockNumber,
      env.MAX_LOG_RANGE_BLOCKS,
      env.MIN_RPC_DELAY_MS,
      fetchPositionsChunk.bind(this)
    );
  }

  async fetchNewPositions(currentBlockNumber: number): Promise<Compound3Position[]> {
    const { targetChainLastBlock } = getStorage();

    return this.fetchPositions(targetChainLastBlock - env.BORROWER_LOGS_LOOKBACK_BLOCKS, currentBlockNumber);
  }

  async fetchTargetChainCurrentBlockNumber() {
    const { provider } = getStorage().baseConnectors;
    return provider.getBlockNumber();
  }

  async onFetchAndFilterNewPositions() {
    const { allPositions, currentPositions, interestingPositions } = getStorage();

    // Fetch the current block number.
    const currentBlockNumber = await this.fetchTargetChainCurrentBlockNumber();

    // Fetch the new position from the logs. These are the users that interacted with the dApp in the specific block range.
    const newPositions = await this.fetchNewPositions(currentBlockNumber);
    const { currentPositions: fetchedCurrentPositions, interestingPositions: fetchedInterestingPositions } =
      await filterPositions(newPositions);

    // Merge the fetched positions with the existing positions.
    const newAllPositions = mergePositions(allPositions, newPositions);
    const newCurrentPositions = mergePositions(currentPositions, fetchedCurrentPositions);
    const newInterestingPositions = mergePositions(interestingPositions, fetchedInterestingPositions);

    // Persist the positions in the storage along with the current block number.
    updateStorage((draft) => {
      draft.allPositions = newAllPositions;
      draft.currentPositions = newCurrentPositions;
      draft.interestingPositions = newInterestingPositions;
      draft.targetChainLastBlock = currentBlockNumber;
    });

    // Note, that positions and interesting positions are only added - no existing
    // one is removed.
    const { addedPositions: addedInterestingPositions } = this.getPositionDifference(
      interestingPositions,
      newInterestingPositions
    );
    const { addedPositions: addedCurrentPositions } = this.getPositionDifference(currentPositions, newCurrentPositions);
    const { addedPositions } = this.getPositionDifference(allPositions, newAllPositions);

    logger.info('New positions after logs refetch', {
      addedPositions,
      addedCurrentPositions,
      addedInterestingPositions,
    });
  }

  async onResetInterestingPositions() {
    const { currentPositions } = getStorage();
    const { interestingPositions } = await filterPositions(currentPositions);

    const { addedPositions, discardedPositions } = this.getPositionDifference(
      getStorage().interestingPositions,
      interestingPositions
    );

    logger.info('Interesting positions after reset', {
      interestingPositions: interestingPositions.length,
      addedPositions,
      discardedPositions,
    });
    updateStorage((draft) => {
      draft.interestingPositions = interestingPositions;
    });
  }

  async onResetCurrentPositions() {
    const { allPositions } = getStorage();
    const { currentPositions: newCurrentPositions, interestingPositions: newInterestingPositions } =
      await filterPositions(allPositions);

    const { addedPositions: addedCurrentPositions, discardedPositions: discardedCurrentPositions } =
      this.getPositionDifference(getStorage().currentPositions, newCurrentPositions);
    const { addedPositions: addedInterestingPositions, discardedPositions: discardedInterestingPositions } =
      this.getPositionDifference(getStorage().interestingPositions, newInterestingPositions);

    logger.info('Positions after reset', {
      currentPositions: newCurrentPositions.length,
      interestingPositions: newInterestingPositions.length,
      addedCurrentPositions,
      discardedCurrentPositions,
      addedInterestingPositions,
      discardedInterestingPositions,
    });

    if (addedCurrentPositions.length > 0) {
      // This should only happen when a position with little borrowed amount has crossed the min position size limit due to price movements
      logger.warn('Found missing current position(s)', { addedCurrentPositions });
    }

    updateStorage((draft) => {
      draft.currentPositions = newCurrentPositions;
      draft.interestingPositions = newInterestingPositions;
    });
  }

  async onInitiateOevLiquidations() {
    const { currentlyLiquidatedPositions } = getStorage();

    if (currentlyLiquidatedPositions.length > 0) {
      logger.info('Skipping liquidation as another liquidation is in progress.', { currentlyLiquidatedPositions });
      return;
    }

    const liquidatablePositions = await findLiquidatablePositions();

    setTimeout(async () => {
      const positionsToLiquidate = liquidatablePositions.slice(0, env.MAX_POSITIONS_TO_LIQUIDATE);

      if (positionsToLiquidate.length === 0) {
        logger.info('No liquidations found.');
        return;
      }

      const liquidatedPositions = positionsToLiquidate.map(({ position }) => position);

      logger.info('Attempting liquidation(s)', {
        positions: liquidatedPositions,
      });

      updateStorage((draft) => {
        draft.currentlyLiquidatedPositions = liquidatedPositions;
      });

      const goLiquidate = await go(() => liquidatePositions(positionsToLiquidate), {
        totalTimeoutMs: LIQUIDATION_HARD_TIMEOUT_MS,
      });

      updateStorage((draft) => {
        draft.currentlyLiquidatedPositions = [];
      });

      if (goLiquidate.error) {
        logger.error('Unexpected liquidation error', goLiquidate.error);
      }
    }, 0);
  }

  async start() {
    await this.initialize();

    void runInLoop(
      this.onFetchAndFilterNewPositions.bind(this),
      createRunInLoopOptions(
        'fetch-and-filter-new-positions',
        env.FETCH_AND_FILTER_NEW_POSITIONS_FREQUENCY_MS,
        env.RUN_IN_LOOP_MAX_WAIT_TIME_PERCENTAGE
      )
    );
    void runInLoop(
      this.onResetInterestingPositions.bind(this),
      createRunInLoopOptions(
        'reset-interesting-positions',
        env.RESET_INTERESTING_POSITIONS_FREQUENCY_MS,
        env.RUN_IN_LOOP_MAX_WAIT_TIME_PERCENTAGE
      )
    );
    void runInLoop(
      this.onResetCurrentPositions.bind(this),
      createRunInLoopOptions(
        'reset-current-positions',
        env.RESET_CURRENT_POSITIONS_FREQUENCY_MS,
        env.RUN_IN_LOOP_MAX_WAIT_TIME_PERCENTAGE
      )
    );
    void runInLoop(
      this.onInitiateOevLiquidations.bind(this),
      createRunInLoopOptions(
        'initiate-oev-liquidations',
        env.INITIATE_OEV_LIQUIDATIONS_FREQUENCY_MS,
        env.RUN_IN_LOOP_MAX_WAIT_TIME_PERCENTAGE
      )
    );

    return new Promise(noop); // Return a never-resolving promise because the loops run forever.
  }
}
