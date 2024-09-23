import { type RunInLoopOptions, type Hex, sleep } from '@api3/commons';
import { ethers } from 'ethers';
import { uniq } from 'lodash';

import { PERCENTAGE_VALUE_MANTISSA, RUN_IN_LOOP_HARD_TIMEOUT_MULTIPLIER } from './constants';
import { type Compound3Position } from './lib/storage';
import { logger } from './logger';

export const generateRandomBytes32 = () => {
  return ethers.hexlify(ethers.randomBytes(32)) as Hex;
};

export const mergePositions = (
  existingPositions: Compound3Position[],
  newPositions: Compound3Position[]
): Compound3Position[] => {
  return uniq([...existingPositions, ...newPositions]);
};

export const createRunInLoopOptions = (
  logLabel: Lowercase<string>,
  frequencyMs: number,
  maxWaitTimePercentage: number,
  initialDelayMs = frequencyMs
): RunInLoopOptions => {
  return {
    logger,
    logLabel,
    frequencyMs,
    hardTimeoutMs: frequencyMs * RUN_IN_LOOP_HARD_TIMEOUT_MULTIPLIER,
    enabled: true,
    maxWaitTimeMs: getPercentageValue(frequencyMs, maxWaitTimePercentage),
    initialDelayMs,
  };
};

export async function fetchPositions(
  startBlockNumber: number,
  endBlockNumber: number,
  maxLogBlockRange: number,
  rpcDelayMs: number,
  fetchPositionsChunk: (startBlockNumber: number, endBlockNumber: number) => Promise<Compound3Position[]>
) {
  let fetchedPositions: Compound3Position[] = [];
  let actualStartBlockNumber = Math.max(startBlockNumber, 0);

  while (actualStartBlockNumber <= endBlockNumber) {
    const actualEndBlockNumber = Math.min(actualStartBlockNumber + maxLogBlockRange, endBlockNumber);
    logger.info('Fetched positions in block range', { start: actualStartBlockNumber, end: actualEndBlockNumber });
    const positions = await fetchPositionsChunk(actualStartBlockNumber, actualEndBlockNumber);

    fetchedPositions = mergePositions(fetchedPositions, positions);
    actualStartBlockNumber += maxLogBlockRange;
    await sleep(rpcDelayMs);
  }

  return [...fetchedPositions.values()];
}

export const getPercentageValue = <T extends number | bigint>(value: T, percent: number): T => {
  // eslint-disable-next-line lodash/prefer-lodash-typecheck
  if (typeof value === 'number') return Math.trunc(value * (percent / 100)) as T;

  return (((value as bigint) * BigInt(Math.trunc(percent * PERCENTAGE_VALUE_MANTISSA))) /
    BigInt(PERCENTAGE_VALUE_MANTISSA) /
    100n) as T;
};
