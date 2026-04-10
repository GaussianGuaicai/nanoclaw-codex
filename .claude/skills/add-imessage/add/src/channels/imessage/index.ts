import fs from 'fs';

import { logger } from '../../logger.js';
import { registerChannel, ChannelOpts } from '../registry.js';
import { getIMessageConfig } from './backend.js';
import { IMessageChannel } from './channel.js';

registerChannel('imessage', (opts: ChannelOpts) => {
  const config = getIMessageConfig();

  if (!config.enabled) {
    logger.info('iMessage channel disabled via IMESSAGE_ENABLED');
    return null;
  }

  if (config.backend === 'bluebubbles') {
    logger.warn(
      'IMESSAGE_BACKEND=bluebubbles is not implemented yet; skipping iMessage channel startup',
    );
    return null;
  }

  if (config.backend === 'local-macos' && process.platform !== 'darwin') {
    logger.info(
      { platform: process.platform },
      'Skipping iMessage local-macos backend on non-macOS host',
    );
    return null;
  }

  if (!fs.existsSync(config.dbPath)) {
    logger.warn(
      { dbPath: config.dbPath },
      'Skipping iMessage channel: IMESSAGE_DB_PATH not found',
    );
    return null;
  }

  return new IMessageChannel({ ...opts, config });
});
