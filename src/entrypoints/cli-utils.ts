import '../bigint-monkeypatch';
import { runCliUtils } from '../cli-utils';
import { logger } from '../logger';

void runCliUtils().catch((error: Error) => {
  logger.error('Unexpected error', error);
  process.exit(1);
});
