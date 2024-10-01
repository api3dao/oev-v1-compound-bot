import { readFileSync } from 'node:fs';

import { runInLoop } from '@api3/commons';
import { go, goSync } from '@api3/promise-utils';
import { difference, noop } from 'lodash';

import {
  fetchDataFeedIds,
  fetchDataFeedsDetails,
  getRealTimeFeedValues,
  getUpdateDataFeedSignedData,
  type SignedData,
} from './beacons';
import { DAPP_ID, LIQUIDATION_HARD_TIMEOUT_MS, OEV_AWARD_BLOCK_RANGE } from './constants';
import { env } from './env';
import { compound3Api3Feeds } from './lib/compound3';
import {
  calculateExpectedProfit,
  findLiquidatablePositions,
  liquidatePositions,
  placeBid,
} from './lib/oev-liquidation';
import { fetchPositionsChunk, filterPositions, POSITIONS_TO_WATCH_FILE_PATH } from './lib/positions';
import { type Compound3Position, getStorage, initializeStorage, updateStorage } from './lib/storage';
import { logger } from './logger';
import { createRunInLoopOptions, fetchPositions, getPercentageValue, mergePositions } from './utils';

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
    initializeStorage(compound3Api3Feeds);
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

  getCurrentBeaconSets() {
    const { api3FeedsToWatch, dataFeedIdToBeacons, dapiNameHashToDataFeedId } = getStorage();
    const beaconSets = api3FeedsToWatch.map((feed) => {
      const dataFeedId = dapiNameHashToDataFeedId[feed.dapiNameHash];
      if (!dataFeedId) {
        logger.warn('Data feed ID not found for dAPI', { dapiName: feed.dapiName });
        return [];
      }
      const beacons = dataFeedIdToBeacons[dataFeedId];
      if (!beacons) {
        logger.warn('Beacons not found for data feed ID', { dataFeedId });
        return [];
      }

      return beacons;
    });

    logger.info('Current beacon sets', { count: beaconSets.length });
    return beaconSets;
  }

  async getDataFeedsBeacons() {
    const { dataFeedIdToBeacons, api3FeedsToWatch } = getStorage();
    const targetChainConnectors = getStorage().baseConnectors;

    // Fetch the data feed ID for all given API3 feeds (dAPIs) in a single RPC call.
    const dataFeedIds = await fetchDataFeedIds(
      targetChainConnectors.api3ServerV1,
      api3FeedsToWatch.map((feed) => feed.dapiNameHash)
    );

    // If the RPC call failed, return the last known beacons for the dAPIs.
    if (!dataFeedIds) return this.getCurrentBeaconSets().flat();

    // Persist the current data feed IDs for the dAPIs in storage.
    updateStorage((draft) => {
      for (const [i, { dapiNameHash }] of api3FeedsToWatch.entries()) {
        draft.dapiNameHashToDataFeedId[dapiNameHash] = dataFeedIds[i]!;
      }
    });

    // Fetch and persist data feed details for all data feeds that we're missing in storage.
    const missingDataFeedIds = dataFeedIds.filter((feedId) => !(feedId in dataFeedIdToBeacons));
    if (missingDataFeedIds.length > 0) {
      const dataFeedDetails = await fetchDataFeedsDetails(targetChainConnectors.airseekerRegistry, missingDataFeedIds);
      if (dataFeedDetails) {
        updateStorage((draft) => {
          for (const [i, dataFeedDetail] of dataFeedDetails.entries()) {
            if (dataFeedDetail) draft.dataFeedIdToBeacons[missingDataFeedIds[i]!] = dataFeedDetail;
          }
        });
      }
    }

    // Get the beacons for all the data feeds. Note, that the call needs to get the fresh state, because the steps above
    // may update the dAPI details.
    return this.getCurrentBeaconSets().flat();
  }

  getDappOevUpdateDataFeedSignedData(realTimeFeedValues: SignedData[]): string[][] {
    const beaconSets = this.getCurrentBeaconSets();
    return getUpdateDataFeedSignedData(realTimeFeedValues, beaconSets);
  }

  async getDappOevDataFeedSimulateCalls(signedDataArray: string[][]): Promise<string[]> {
    const { api3ServerV1OevExtension } = getStorage().baseConnectors;

    return signedDataArray.map((signedData) =>
      api3ServerV1OevExtension.interface.encodeFunctionData('simulateDappOevDataFeedUpdate', [DAPP_ID, signedData])
    );
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
    const { currentlyLiquidatedPositions, oevNetworkConnectors } = getStorage();

    if (currentlyLiquidatedPositions.length > 0) {
      logger.info('Skipping liquidation as another liquidation is in progress.', { currentlyLiquidatedPositions });
      return;
    }

    const dataFeedBeacons = await this.getDataFeedsBeacons();
    if (!dataFeedBeacons) return;

    const realTimeFeedValues = await getRealTimeFeedValues(dataFeedBeacons, env.SIGNED_API_FETCH_DELAY_MS);
    const signedDataArray = this.getDappOevUpdateDataFeedSignedData(realTimeFeedValues);
    const dapiSimulateUpdateCalls = await this.getDappOevDataFeedSimulateCalls(signedDataArray);
    const liquidatablePositions = await findLiquidatablePositions(dapiSimulateUpdateCalls);
    const positionsToLiquidate = liquidatablePositions.slice(0, env.MAX_POSITIONS_TO_LIQUIDATE);

    if (positionsToLiquidate.length === 0) {
      logger.info('No liquidations found.');
      return;
    }

    const expectedProfit = await calculateExpectedProfit(dapiSimulateUpdateCalls, positionsToLiquidate);
    const bidAmount = getPercentageValue(expectedProfit, 80);
    const placedBid = await placeBid(bidAmount);
    if (!placedBid) {
      return; // Failure already logged
    }
    const { bidId, bidTopic, signedDataTimestampCutoff } = placedBid;
    const positions = positionsToLiquidate.map(({ position }) => position);

    updateStorage((draft) => {
      draft.currentlyLiquidatedPositions = positions;
    });

    setTimeout(async () => {
      const awardedBidFilter = oevNetworkConnectors.oevAuctionHouse.filters.AwardedBid(undefined, bidTopic);
      const goAwardedBid = await go(
        async () => {
          const blockNumber = await oevNetworkConnectors.provider.getBlockNumber();
          const awardedBid = await oevNetworkConnectors.oevAuctionHouse.queryFilter(
            awardedBidFilter,
            blockNumber - OEV_AWARD_BLOCK_RANGE,
            blockNumber
          );
          if (awardedBid.length === 0) throw new Error('No award found in this polling attempt');
          return awardedBid[0]!;
        },
        {
          retries: 25,
          delay: {
            type: 'static',
            delayMs: env.OEV_POLL_AWARD_BID_DELAY_MS,
          },
        }
      );

      if (goAwardedBid.error) {
        logger.error('Failed to poll awarded bid', goAwardedBid.error);
        return;
      }
      if (goAwardedBid.data.args.bidId !== bidId) {
        logger.error('Unexpected bid won the auction', { winningBidId: goAwardedBid.data.args.bidId, bidId });
        return;
      }

      logger.info('Attempting liquidation(s)', {
        positions,
      });

      const goLiquidate = await go(
        () =>
          liquidatePositions(
            positionsToLiquidate,
            bidAmount,
            goAwardedBid.data.args.awardDetails,
            signedDataArray,
            signedDataTimestampCutoff
          ),
        {
          totalTimeoutMs: LIQUIDATION_HARD_TIMEOUT_MS,
        }
      );

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
