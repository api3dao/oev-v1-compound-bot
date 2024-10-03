import dotenv from 'dotenv';
import { cleanEnv, str, bool, num, makeValidator } from 'envalid';
import { parseEther } from 'ethers';

dotenv.config();

const etherValidator = makeValidator<bigint>(parseEther);

export const env = cleanEnv(process.env, {
  NODE_ENV: str({ choices: ['development', 'test', 'production'], default: 'development' }),

  LOG_COLORIZE: bool({ default: false }),
  LOG_FORMAT: str({ choices: ['json', 'pretty'] }),
  LOG_LEVEL: str({ choices: ['debug', 'info', 'warn', 'error'] }),
  LOGGER_ENABLED: bool({ default: true }),

  BORROWER_LOGS_LOOKBACK_BLOCKS: num(),
  COMET_ADDRESS: str(),
  FETCH_AND_FILTER_NEW_POSITIONS_FREQUENCY_MS: num(),
  HOT_WALLET_PRIVATE_KEY: str(),
  INITIALIZE_TARGET_CHAIN_TIMEOUT_MS: num(),
  INITIATE_OEV_LIQUIDATIONS_FREQUENCY_MS: num(),
  LIQUIDATION_TRANSACTION_TIMEOUT_MS: num(),
  LIQUIDATOR_CONTRACT_ADDRESS: str(),
  MAX_BORROWER_DETAILS_MULTICALL: num(),
  MAX_LOG_RANGE_BLOCKS: num(),
  MAX_POSITIONS_TO_LIQUIDATE: num(),
  MIN_POSITION_USD_E18: etherValidator(),
  MIN_RPC_DELAY_MS: num(),
  RESET_CURRENT_POSITIONS_FREQUENCY_MS: num(),
  RESET_INTERESTING_POSITIONS_FREQUENCY_MS: num(),
  RPC_URL: str(),
  RUN_IN_LOOP_MAX_WAIT_TIME_PERCENTAGE: num(),
});
