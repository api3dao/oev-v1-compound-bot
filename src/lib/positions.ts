import { join } from 'node:path';

import { sleep } from '@api3/commons';
import { chunk } from 'lodash';

import allPositionsJsonFile from '../all-positions.json';
import { defaultAllPositions } from '../cli-utils';
import { PERCENTAGE_VALUE_MANTISSA } from '../constants';
import { env } from '../env';
import { logger } from '../logger';
import { fetchPositions, mergePositions } from '../utils';

import { type Compound3PositionDetails } from './compound3';
import { type Compound3Position, getStorage } from './storage';

export const ALL_POSITIONS_FILE_PATH = join(__dirname, '../all-positions.json');
export const POSITIONS_TO_WATCH_FILE_PATH = join(__dirname, '../positions-to-watch.json.ignore');

export const PRICE_FACTOR_SCALE_DIGITS = 8n;
export const PRICE_FACTOR_SCALE = 10n ** PRICE_FACTOR_SCALE_DIGITS;

export const computeLoanToValueFactor = (borrowUsd: bigint, maxBorrowUsd: bigint) => {
  if (maxBorrowUsd === 0n) return 0;

  return (Number((borrowUsd * BigInt(PERCENTAGE_VALUE_MANTISSA)) / maxBorrowUsd) / PERCENTAGE_VALUE_MANTISSA) * 100;
};

const isPositionCurrentlySignificant = (position: Compound3PositionDetails) => {
  // The minimum position treshold uses 10^18 as precision. We check that the position needs to have sufficient
  // amount as collateral, because the liquidation profit is based on the percentage of the collateral.
  const minCollateral = (env.MIN_POSITION_USD_E18 * PRICE_FACTOR_SCALE) / 10n ** 18n;
  return position.collateralUsd >= minCollateral && position.borrowUsd > 0n;
};

const isPositionInteresting = (position: Compound3PositionDetails) => {
  return isPositionCurrentlySignificant(position) && position.loanToValue >= 80;
};

const getPositionsDetails = async (positions: Compound3Position[]) => {
  logger.info('Filtering interesting positions');

  const { compound3Connectors } = getStorage();
  const positionsDetails: Compound3PositionDetails[] = [];

  const chunks = chunk(positions, env.MAX_BORROWER_DETAILS_MULTICALL);
  for (const [index, positionBatch] of chunks.entries()) {
    logger.info('Fetching user account data for positions', { index, count: chunks.length });

    const { borrowsUsd, maxBorrowsUsd, collateralsUsd, areLiquidatable } =
      await compound3Connectors.compound3Liquidator.getAccountsDetails(positionBatch);

    // eslint-disable-next-line unicorn/no-for-loop
    for (let i = 0; i < positionBatch.length; i++) {
      // The minimum position treshold uses 10^18 as precision. We check that the position needs to have sufficient
      // amount as collateral, because the liquidation profit is based on the percentage of the collateral.

      const loanToValue = computeLoanToValueFactor(borrowsUsd[i]!, maxBorrowsUsd[i]!);
      positionsDetails.push({
        position: positionBatch[i]!,
        borrowUsd: borrowsUsd[i]!,
        maxBorrowUsd: maxBorrowsUsd[i]!,
        collateralUsd: collateralsUsd[i]!,
        isLiquidatable: areLiquidatable[i]!,
        loanToValue,
      });
    }

    await sleep(env.MIN_RPC_DELAY_MS);
  }

  return positionsDetails;
};

export const filterPositions = async (positions: Compound3Position[]) => {
  logger.info('Filtering positions');

  const positionsDetails = await getPositionsDetails(positions);
  const interestingPositions = positionsDetails
    .filter((position) => isPositionInteresting(position))
    .map(({ position }) => position);
  const currentPositions = positionsDetails
    .filter((position) => isPositionCurrentlySignificant(position))
    .map(({ position }) => position);

  return { currentPositions, interestingPositions };
};

export const fetchPositionsChunk = async (startBlockNumber: number, endBlockNumber: number) => {
  const events = await (async (fromBlock: number, toBlock: number) => {
    const { baseConnectors, compound3Connectors } = getStorage();
    const logs = await baseConnectors.provider.getLogs({
      address: env.COMET_ADDRESS,
      fromBlock,
      toBlock,
      // When an user borrows an asset, it's withdrawn from the Comet and a Withdraw event is emitted. See:
      // https://docs.compound.finance/collateral-and-borrowing/#withdraw-or-borrow
      topics: [[compound3Connectors.usdcComet.filters.Withdraw.fragment.topicHash]],
    });

    return logs.map((log) => compound3Connectors.usdcComet.interface.parseLog(log)!);
  })(startBlockNumber, endBlockNumber);
  return events.map((event) => event.args.src);
};

export const getAllPositions = async (resetPositions: boolean) => {
  const { baseConnectors } = getStorage();
  const endBlockNumber = await baseConnectors.provider.getBlockNumber();
  const { allPositions: cachedPositions, lastBlock } = resetPositions ? defaultAllPositions : allPositionsJsonFile;

  const positions = await fetchPositions(
    lastBlock - env.BORROWER_LOGS_LOOKBACK_BLOCKS,
    endBlockNumber,
    env.MAX_LOG_RANGE_BLOCKS,
    env.MIN_RPC_DELAY_MS,
    fetchPositionsChunk
  );

  const allPositions = mergePositions(cachedPositions, positions);
  logger.debug('Fetched unique positions', { count: allPositions.length });

  return { allPositions, lastBlock: endBlockNumber };
};
