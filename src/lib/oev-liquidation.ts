import { sleep } from '@api3/commons';
import { go } from '@api3/promise-utils';
import { ethers, formatEther, formatUnits, MaxUint256, VoidSigner } from 'ethers';
import { chunk, orderBy } from 'lodash';

import { type Compound3Liquidator, type IComet } from '../../typechain-types';
import { type TypedEventLog } from '../../typechain-types/common';
import {
  DAPP_ID,
  OEV_AUCTION_LENGTH_SECONDS,
  OEV_AUCTIONEER_MAJOR_VERSION,
  OEV_BIDDING_PHASE_BUFFER_SECONDS,
  OEV_BIDDING_PHASE_LENGTH_SECONDS,
  POSITIONS_CLOSE_TO_LIQUIDATION_LOG_SIZE,
} from '../constants';
import { env } from '../env';
import { logger } from '../logger';
import { getPercentageValue } from '../utils';

import { type Compound3PositionDetails, type GetAccountsDetails } from './compound3';
import { computeLoanToValueFactor } from './positions';
import { getStorage } from './storage';

export interface ReportFulfillmentParams {
  bidTopic: string;
  bidDetailsHash: string;
  fulfillmentDetails: string;
}

export const findLiquidatablePositions = async (dapiUpdateCalls: string[]) => {
  const {
    interestingPositions,
    baseConnectors: { api3ServerV1OevExtension, provider },
    compound3Connectors: { compound3Liquidator },
  } = getStorage();

  const liquidatorAddress = await compound3Liquidator.getAddress();

  const accountsWithLiquidationInfo = [];
  for (const batch of chunk(interestingPositions, env.MAX_BORROWER_DETAILS_MULTICALL)) {
    const calls = [
      ...dapiUpdateCalls,
      api3ServerV1OevExtension.interface.encodeFunctionData('simulateExternalCall', [
        liquidatorAddress,
        compound3Liquidator.interface.encodeFunctionData('getAccountsDetails', [batch]),
      ]),
    ];

    // Perform the staticcall. This updates all of the feeds and determines whether the account is liquidatable.
    const goStaticCall = await go(async () =>
      api3ServerV1OevExtension
        .connect(new VoidSigner(ethers.ZeroAddress).connect(provider))
        .tryMulticall.staticCall(calls)
    );

    // Handle the RPC error.
    if (goStaticCall.error) {
      logger.error(`Error getting liquidation info: ${goStaticCall.error.message}`);
      continue;
    }

    const accountDetailsCallResultSuccess = goStaticCall.data.successes.at(-1)!;
    const accountDetailsCallResultReturnData = goStaticCall.data.returndata.at(-1)!;
    if (!accountDetailsCallResultSuccess) {
      // This should never happen.
      logger.error('Failed to get account details', { returnData: accountDetailsCallResultReturnData });
      continue;
    }

    // Parse the returndata from the staticcall (excluding the dAPI update calls).
    const { borrowsUsd, maxBorrowsUsd, collateralsUsd, areLiquidatable } =
      compound3Liquidator.interface.decodeFunctionResult(
        'getAccountsDetails',
        api3ServerV1OevExtension.interface.decodeFunctionResult(
          'simulateExternalCall',
          accountDetailsCallResultReturnData
        )[0]
      ) as unknown as GetAccountsDetails;

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

export const calculateExpectedProfit = async (
  dapiUpdateCalls: string[],
  liquidatablePositions: Compound3PositionDetails[]
) => {
  const {
    baseConnectors: { api3ServerV1OevExtension, provider },
    compound3Connectors: { compound3Liquidator },
  } = getStorage();

  const liquidatorAddress = await compound3Liquidator.getAddress();

  let totalProfit = 0n;
  let totalProfitUsd = 0n;
  for (const batch of chunk(liquidatablePositions, env.MAX_SIMULATE_LIQUIDATIONS_MULTICALL)) {
    const calls = [
      ...dapiUpdateCalls,
      api3ServerV1OevExtension.interface.encodeFunctionData('simulateExternalCall', [
        liquidatorAddress,
        compound3Liquidator.interface.encodeFunctionData('liquidate', [
          {
            liquidatableAccounts: batch.map(({ position }) => position),
            maxAmountsToPurchase: [MaxUint256, MaxUint256, MaxUint256],
            liquidationThreshold: 0n,
          },
        ]),
      ]),
    ];

    // Perform the staticcall. This updates all of the feeds and gets liquidation profit.
    const goStaticCall = await go(async () =>
      api3ServerV1OevExtension
        .connect(new VoidSigner(ethers.ZeroAddress).connect(provider))
        .tryMulticall.staticCall(calls)
    );

    // Handle the RPC error.
    if (goStaticCall.error) {
      logger.error(`Error getting liquidation info: ${goStaticCall.error.message}`);
      continue;
    }

    const liquidateCallResultSuccess = goStaticCall.data.successes.at(-1)!;
    const liquidateCallResultReturnData = goStaticCall.data.returndata.at(-1)!;
    if (!liquidateCallResultSuccess) {
      logger.error('Failed to get liquidation profits', { returnData: liquidateCallResultReturnData });
      continue;
    }

    // Parse the returndata from the staticcall (excluding the dAPI update calls).
    const [profit, profitUsd] = compound3Liquidator.interface.decodeFunctionResult(
      'liquidate',
      api3ServerV1OevExtension.interface.decodeFunctionResult('simulateExternalCall', liquidateCallResultReturnData)[0]
    ) as unknown as [bigint, bigint];

    totalProfit += profit;
    totalProfitUsd += profitUsd;

    await sleep(env.MIN_RPC_DELAY_MS);
  }

  logger.info('Total expected profit', {
    totalProfit: formatEther(totalProfit),
    totalProfitUsd: formatUnits(totalProfitUsd, 8),
  });
  return totalProfit;
};

const determineSignedDataTimestampCutoff = () => {
  const auctionOffset = Number(
    BigInt(ethers.solidityPackedKeccak256(['uint256'], [DAPP_ID])) % BigInt(OEV_AUCTION_LENGTH_SECONDS)
  );
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const timeInCurrentAuction = (currentTimestamp - auctionOffset) % OEV_AUCTION_LENGTH_SECONDS;
  const auctionStartTimestamp = currentTimestamp - timeInCurrentAuction;
  const biddingPhaseEndTimestamp = auctionStartTimestamp + OEV_BIDDING_PHASE_LENGTH_SECONDS;
  let signedDataTimestampCutoff = auctionStartTimestamp + OEV_BIDDING_PHASE_LENGTH_SECONDS;

  if (biddingPhaseEndTimestamp - currentTimestamp < OEV_BIDDING_PHASE_BUFFER_SECONDS) {
    logger.info('Not enough time to place bid in current auction, bidding for the next one', {
      currentTimestamp,
      biddingPhaseEndTimestamp,
      auctionOffset,
    });
    signedDataTimestampCutoff += OEV_AUCTION_LENGTH_SECONDS;
  }

  return signedDataTimestampCutoff;
};

export const placeBid = async (bidAmount: bigint) => {
  const { oevNetworkConnectors, compound3Connectors, baseConnectors } = getStorage();
  const { chainId } = await baseConnectors.provider.getNetwork();

  const liquidatorAddress = await compound3Connectors.compound3Liquidator.getAddress();
  const nonce = ethers.hexlify(ethers.randomBytes(32));
  const bidDetails = ethers.AbiCoder.defaultAbiCoder().encode(['address', 'bytes32'], [liquidatorAddress, nonce]);

  const signedDataTimestampCutoff = determineSignedDataTimestampCutoff();
  const nextBiddingPhaseEndTimestamp = signedDataTimestampCutoff + OEV_AUCTION_LENGTH_SECONDS;

  const sender = oevNetworkConnectors.wallet.address;
  const bidDetailsHash = ethers.keccak256(bidDetails);
  const bidTopic = ethers.solidityPackedKeccak256(
    ['uint256', 'uint256', 'uint32', 'uint32'],
    [OEV_AUCTIONEER_MAJOR_VERSION, DAPP_ID, OEV_AUCTION_LENGTH_SECONDS, signedDataTimestampCutoff]
  );
  const bidId = ethers.solidityPackedKeccak256(['address', 'bytes32', 'bytes32'], [sender, bidTopic, bidDetailsHash]);

  logger.info('Placing bid', { bidId, bidTopic, bidAmount, bidDetails, nextBiddingPhaseEndTimestamp });
  const txResponse = await oevNetworkConnectors.oevAuctionHouse
    .connect(oevNetworkConnectors.wallet)
    .placeBidWithExpiration(
      bidTopic,
      chainId,
      bidAmount,
      bidDetails,
      bidAmount,
      bidAmount,
      nextBiddingPhaseEndTimestamp
    );

  const txReceipt = await txResponse.wait(1, env.OEV_PLACE_BID_TRANSACTION_TIMEOUT_MS);

  if (txReceipt === null) {
    logger.error('Waiting for transaction receipt timed out');
    return { bidId, bidTopic, bidDetailsHash, signedDataTimestampCutoff };
  }
  const { hash: txHash } = txReceipt;

  if (txReceipt.status === 0) {
    logger.error('Placing bid reverted', { txHash });
    return null;
  }
  logger.info('Bid placed successfully', { txHash });

  return { bidId, bidTopic, bidDetailsHash, signedDataTimestampCutoff };
};

export const liquidatePositions = async (
  liquidatablePositions: Compound3PositionDetails[],
  bidAmount: bigint,
  signature: string,
  signedDataArray: string[][],
  signedDataTimestampCutoff: number
) => {
  const { compound3Connectors, baseConnectors } = getStorage();

  // Prepare liquidation calldata.
  const liquidationParams: Compound3Liquidator.PayBidAndUpdateFeedsAndLiquidateParamsStruct = {
    payOevBidCallbackData: {
      signedDataArray,
      liquidateParams: {
        liquidatableAccounts: liquidatablePositions.map(({ position }) => position),
        maxAmountsToPurchase: [MaxUint256, MaxUint256, MaxUint256],
        liquidationThreshold: 0n,
      },
    },
    bidAmount,
    signature,

    signedDataTimestampCutoff,
  };

  const goSimulate = await go(async () => {
    // Compute the gas limit for the transaction.
    const estimatedGasLimitPromise = compound3Connectors.compound3Liquidator
      .connect(baseConnectors.wallet)
      .payBidAndUpdateFeedsAndLiquidate.estimateGas(liquidationParams);

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
    .payBidAndUpdateFeedsAndLiquidate(liquidationParams, { gasPrice, nonce, gasLimit });
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

  return txReceipt;
};

export const reportFulfillment = async (params: ReportFulfillmentParams) => {
  logger.info('Reporting fulfillment', params);
  const { oevAuctionHouse, wallet } = getStorage().oevNetworkConnectors;
  const { bidTopic, bidDetailsHash, fulfillmentDetails } = params;

  return oevAuctionHouse.connect(wallet).reportFulfillment(bidTopic, bidDetailsHash, fulfillmentDetails);
};
