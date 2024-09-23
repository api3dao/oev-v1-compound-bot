import { createLogger } from '@api3/commons';

import { env } from './env';

export const logger = createLogger({
  colorize: env.LOG_COLORIZE,
  enabled: env.LOGGER_ENABLED,
  minLevel: env.LOG_LEVEL,
  format: env.LOG_FORMAT,
});
