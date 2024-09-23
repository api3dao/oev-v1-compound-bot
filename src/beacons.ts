import { deriveBeaconId, executeRequest, sleep, type Address, type Hex } from '@api3/commons';
import {
  DapiProxyWithOev__factory as DapiProxyWithOevFactory,
  type AirseekerRegistry,
  type Api3ServerV1,
} from '@api3/contracts';
import { go } from '@api3/promise-utils';
import { ethers } from 'ethers';
import { groupBy } from 'lodash';

import { type Multicall3 } from '../typechain-types';

import { API3_SIGNED_API_BASE_URL, NODARY_SIGNED_API_BASE_URL } from './constants';
import { logger } from './logger';

export interface Beacon {
  airnodeAddress: string;
  templateId: string;
  beaconId: string;
}

export type Api3Feed = {
  proxyAddress: Address;
  dapiName: Hex; // The encoded dAPI name.
  dapiNameHash: Hex; // The hash of the encoded dAPI name (packed keccak256).
  oevEnabled: boolean;
};

export const deriveDapiNameHash = (encodedDapiName: string) =>
  ethers.solidityPackedKeccak256(['bytes32'], [encodedDapiName]) as Hex;

export const prepareApi3Feeds = (api3Feeds: Omit<Api3Feed, 'dapiNameHash'>[]): Api3Feed[] =>
  api3Feeds.map((feed) => ({ ...feed, dapiNameHash: deriveDapiNameHash(feed.dapiName) }));

// From: https://github.com/api3dao/airseeker/blob/main/src/update-feeds-loops/contracts.ts#L61
const decodeDataFeedDetails = (dataFeed: string): Beacon[] | null => {
  // The contract returns empty bytes if the data feed is not registered. See:
  // https://github.com/api3dao/contracts/blob/main/contracts/api3-server-v1/AirseekerRegistry.sol#L346
  if (dataFeed === '0x') return null;

  // This is a hex encoded string, the contract works with bytes directly
  // 2 characters for the '0x' preamble + 32 * 2 hexadecimals for 32 bytes + 32 * 2 hexadecimals for 32 bytes
  if (dataFeed.length === 2 + 32 * 2 + 32 * 2) {
    const [airnodeAddress, templateId] = ethers.AbiCoder.defaultAbiCoder().decode(['address', 'bytes32'], dataFeed);

    const dataFeedId = deriveBeaconId(airnodeAddress, templateId) as Address;

    return [{ beaconId: dataFeedId, airnodeAddress, templateId }];
  }

  const [airnodeAddresses, templateIds] = ethers.AbiCoder.defaultAbiCoder().decode(
    ['address[]', 'bytes32[]'],
    dataFeed
  );

  const beacons = (airnodeAddresses as Address[]).map((airnodeAddress, idx) => {
    const templateId = templateIds[idx] as Hex;
    const beaconId = deriveBeaconId(airnodeAddress, templateId) as Address;

    return { beaconId, airnodeAddress, templateId };
  });

  return beacons;
};

export const getConnectedProxy = (proxyAddress: Address, provider: ethers.JsonRpcProvider) => {
  return DapiProxyWithOevFactory.connect(proxyAddress, provider);
};

export const fetchDataFeedIds = async (api3ServerV1: Api3ServerV1, dapiNameHashes: Hex[]) => {
  const goFetchDataFeedIds = await go(async () => {
    const dapiNameHashToDataFeedIdCalldata = dapiNameHashes.map((dapiNameHash) =>
      api3ServerV1.interface.encodeFunctionData('dapiNameHashToDataFeedId', [dapiNameHash])
    );
    const returndata = await api3ServerV1.multicall.staticCall(dapiNameHashToDataFeedIdCalldata);
    const dataFeedIds = returndata.map(
      (data) => api3ServerV1.interface.decodeFunctionResult('dapiNameHashToDataFeedId', data)[0]
    );

    return dataFeedIds as Hex[];
  });
  if (goFetchDataFeedIds.error) {
    logger.error(`Failed to fetch data feed IDs`, goFetchDataFeedIds.error);
    return null;
  }

  return goFetchDataFeedIds.data;
};

export const fetchDataFeedsDetails = async (airseekerRegistry: AirseekerRegistry, dataFeedIds: Hex[]) => {
  const goFetchDataFeedsDetails = await go(async () => {
    const dataFeedIdToDetailsCalldata = dataFeedIds.map((dataFeedId) =>
      airseekerRegistry.interface.encodeFunctionData('dataFeedIdToDetails', [dataFeedId])
    );
    const returndata = await airseekerRegistry.multicall.staticCall(dataFeedIdToDetailsCalldata);
    const encodedDataFeedDetails = returndata.map(
      (data) => airseekerRegistry.interface.decodeFunctionResult('dataFeedIdToDetails', data)[0] as string
    );

    const decodedDetails = encodedDataFeedDetails.map((encodedDetails) => decodeDataFeedDetails(encodedDetails));
    return decodedDetails;
  });
  if (goFetchDataFeedsDetails.error) {
    logger.error(`Failed to fetch data feed details`, goFetchDataFeedsDetails.error);
    return null;
  }

  return goFetchDataFeedsDetails.data;
};

export type SignedData = SignedDataSingleObject & {
  beaconId: string;
};

type SignedDataSingleObject = {
  airnode: string;
  templateId: string;
  timestamp: number;
  encodedValue: string;
  signature: string;
};

type SignedDataResponse = {
  data: Record<string, SignedDataSingleObject>;
};

const fetchSignedData = async (url: string) => {
  const response = await executeRequest({
    method: 'GET',
    url,
  });
  if (!response.data) {
    logger.warn('Failed to fetch signed data', { url, error: response.errorData });
    // We're throwing an error, so that the Promise.any in getRealTimeFeedValues would disregard this response.
    throw new Error('Failed to fetch signed data');
  }
  return response.data as SignedDataResponse;
};

// Fetches the signed data for multiple beacons across multiple feeds in parallel in an optimal way. If any of the
// Signed API call fails or there is no value for the required beacon, the API will simply omit the values for those
// beacons (this should happen very rarely).
export const getRealTimeFeedValues = async (
  beacons: Beacon[],
  signedApiFetchDelayMs: number
): Promise<SignedData[]> => {
  // Group the beacons by Airnode address to determine how many off-chain calls to make.
  const groupedBeacons = groupBy(beacons, (beacon) => beacon.airnodeAddress);
  const airnodes = Object.keys(groupedBeacons);

  logger.info('Fetching signed data from Signed APIs', { count: airnodes.length });
  const signedApiBeaconsDataPerAirnode = await Promise.all(
    airnodes.map(async (airnodeAddress, index): Promise<SignedData[]> => {
      await sleep(index * signedApiFetchDelayMs);

      const goResponse = await go(async () =>
        Promise.any([
          fetchSignedData(`${API3_SIGNED_API_BASE_URL}/${airnodeAddress}`),
          fetchSignedData(`${NODARY_SIGNED_API_BASE_URL}/${airnodeAddress}`),
        ])
      );

      if (!goResponse.success) return [];

      const response = goResponse.data;
      const beaconIds = groupedBeacons[airnodeAddress]!.map((beacon) => beacon.beaconId);
      const beaconValues = beaconIds
        .map((beaconId) => {
          const value = response.data[beaconId];
          if (!value) {
            logger.warn('Beacon not found in signed data', { airnodeAddress, beaconId, response });
            return null;
          }

          return {
            ...value,
            beaconId,
          };
        })
        .filter(Boolean);

      return beaconValues;
    })
  );

  return signedApiBeaconsDataPerAirnode.flat();
};

export const getBeaconsUpdateCalls = (
  api3ServerV1: Api3ServerV1,
  api3ServerAddress: string,
  realTimeFeedValues: SignedData[]
): Multicall3.Call3Struct[] =>
  realTimeFeedValues.map(({ airnode, templateId, timestamp, encodedValue, signature }) => ({
    target: api3ServerAddress,
    allowFailure: true,
    callData: api3ServerV1.interface.encodeFunctionData('updateBeaconWithSignedData', [
      airnode,
      templateId,
      timestamp,
      encodedValue,
      signature,
    ]),
  }));
