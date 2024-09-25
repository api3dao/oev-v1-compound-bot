import { sleep } from '@api3/commons';
import { go } from '@api3/promise-utils';
import { MaxUint256 } from 'ethers';
import { chunk, orderBy } from 'lodash';

import { type Compound3Liquidator, type IComet } from '../../typechain-types';
import { type TypedEventLog } from '../../typechain-types/common';
import { POSITIONS_CLOSE_TO_LIQUIDATION_LOG_SIZE } from '../constants';
import { env } from '../env';
import { logger } from '../logger';
import { getPercentageValue } from '../utils';

import { type Compound3PositionDetails } from './compound3';
import { computeLoanToValueFactor } from './positions';
import { getStorage } from './storage';

export const findLiquidatablePositions = async () => {
  const {
    interestingPositions,
    compound3Connectors: { compound3Liquidator },
  } = getStorage();

  const accountsWithLiquidationInfo = [];
  for (const batch of chunk(interestingPositions, env.MAX_BORROWER_DETAILS_MULTICALL)) {
    // Perform the staticcall. This updates all of the feeds and determines whether the account is liquidatable.
    const goStaticCall = await go(async () => compound3Liquidator.getAccountsDetails.staticCall(batch));

    // Handle the RPC error.
    if (goStaticCall.error) {
      logger.error(`Error getting liquidation info: ${goStaticCall.error.message}`);
      continue;
    }

    // Parse the returndata from the staticcall (excluding the dAPI update calls).
    const { borrowsUsd, maxBorrowsUsd, collateralsUsd, areLiquidatable } = goStaticCall.data;

    const borrowersWithDetailsBatch = batch.map(
      (_, index): Compound3PositionDetails => ({
        position: batch[index]!,
        borrowUsd: borrowsUsd[index]!,
        maxBorrowUsd: maxBorrowsUsd[index]!,
        collateralUsd: collateralsUsd[index]!,
        isLiquidatable: areLiquidatable[index]!,
        loanToValue: computeLoanToValueFactor(borrowsUsd[index]!, maxBorrowsUsd[index]!),
      })
    );

    accountsWithLiquidationInfo.push(...borrowersWithDetailsBatch);

    await sleep(env.MIN_RPC_DELAY_MS);
  }

  // Print out a portion of the positions close to liquidation.
  const closeToLiquidation = accountsWithLiquidationInfo
    .filter(({ isLiquidatable }) => !isLiquidatable)
    .toSorted((a, b) => (a.loanToValue - b.loanToValue > 0n ? -1 : 1))
    .slice(0, POSITIONS_CLOSE_TO_LIQUIDATION_LOG_SIZE);
  logger.info('Positions close to liquidation', {
    borrowers: closeToLiquidation.map(({ position }) => position),
    loanToValueRatios: closeToLiquidation.map(({ loanToValue }) => loanToValue),
  });

  // Ordering the liquidable borrowers is important because we can only pick a handful of liquidations and we want to
  // prioritize the most profitable ones.
  const liquidatableAccounts = accountsWithLiquidationInfo.filter(({ isLiquidatable }) => isLiquidatable);
  const orderedLiquidations = orderBy(liquidatableAccounts, (account) => account.collateralUsd, 'desc');

  // Print out the details for the liquidatable positions
  logger.info('Details for liquidatable borrowers', {
    count: orderedLiquidations.length,
    borrowers: orderedLiquidations.map(({ position }) => position),
    collateralsUsd: orderedLiquidations.map(({ collateralUsd }) => collateralUsd),
  });

  return orderedLiquidations;
};

export const liquidatePositions = async (liquidatablePositions: Compound3PositionDetails[]) => {
  const { compound3Connectors, baseConnectors } = getStorage();

  // Prepare liquidation call arguments.
  const callArgs: Compound3Liquidator.LiquidateParamsStruct = {
    liquidatableAccounts: liquidatablePositions.map(({ position }) => position),
    maxAmountsToPurchase: [MaxUint256, MaxUint256, MaxUint256],
    liquidationThreshold: 0n,
  };

  const goSimulate = await go(async () => {
    // Compute the gas limit for the transaction.
    const estimatedGasLimitPromise = compound3Connectors.compound3Liquidator
      .connect(baseConnectors.wallet)
      .liquidate.estimateGas(callArgs);

    return Promise.all([estimatedGasLimitPromise, baseConnectors.wallet.getNonce()]);
  });
  if (!goSimulate.success) {
    logger.error(`Unexpected error while preparing the liquidation: ${goSimulate.error.message}`);
    return;
  }

  const [estimatedGasLimit, nonce] = goSimulate.data;
  // We've observed some transactions failing with out-of-gas errors, so we're adding a buffer
  // to the gas limit to compensate for that.
  const gasLimit = getPercentageValue(estimatedGasLimit, 200);

  // Log the estimated RPC gas limit and the gas limit used by transaction.
  logger.info('Gas limits', {
    estimatedGasLimit,
    gasLimit,
  });

  const { gasPrice } = await baseConnectors.provider.getFeeData();
  const txResponse = await compound3Connectors.compound3Liquidator
    .connect(baseConnectors.wallet)
    .liquidate(callArgs, { gasPrice, nonce, gasLimit });
  const txReceipt = await txResponse.wait(1, env.LIQUIDATION_TRANSACTION_TIMEOUT_MS);

  if (txReceipt === null) {
    logger.error('Waiting for transaction receipt timed out');
    return;
  }
  const { hash: txHash, gasUsed } = txReceipt;
  const gasData = {
    gasUsed,
    estimatedGasLimit,
    actualGasLimit: gasLimit,
    gasUsedToGasEstimatePercentage: (Number(gasUsed) * 100) / Number(estimatedGasLimit),
    gasUsedToGasLimitPercentage: (Number(gasUsed) * 100) / Number(gasLimit),
  };

  logger.runWithContext({ gasData, txHash }, () => {
    if (txReceipt.status === 0) {
      logger.error('Liquidation reverted');
      return;
    }

    const positions = liquidatablePositions.map(({ position }) => position);
    const liquidatedPositions = txReceipt.logs
      .filter((log) => log.topics.includes(compound3Connectors.usdcComet.filters.AbsorbCollateral.fragment.topicHash))
      .map((log) => compound3Connectors.usdcComet.interface.parseLog(log))
      .filter(Boolean)
      .map((log) => log.args as unknown as TypedEventLog<IComet['filters']['AbsorbCollateral']>['args'])
      .map((args) => args.borrower);

    const failedLiquidationsPositions = positions.filter((position) => !liquidatedPositions.includes(position));

    if (failedLiquidationsPositions.length === positions.length) {
      logger.error('No liquidation was successful', { failedLiquidationsPositions });
      return;
    }

    if (failedLiquidationsPositions.length > 0) {
      logger.warn('Some liquidations were not successful', {
        failedLiquidationsPositions,
        liquidatedPositions,
      });
      return;
    }

    logger.info('Liquidation successful');
  });
};
