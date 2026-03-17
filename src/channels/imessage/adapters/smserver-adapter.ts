import { logger } from '../../../logger.js';
import {
  IMessageAdapter,
  IMessageChatMeta,
  IMessageInboundEvent,
} from './types.js';

interface SmserverAdapterConfig {
  url: string;
}

export class SmserverAdapter implements IMessageAdapter {
  private readonly url: string;

  constructor(config: SmserverAdapterConfig) {
    this.url = config.url;
  }

  async connect(): Promise<void> {
    logger.info(
      { backend: 'smserver', url: this.url },
      'SMServer adapter placeholder connected',
    );
  }

  async subscribeInbound(
    _handler: (event: IMessageInboundEvent) => void,
  ): Promise<void> {
    logger.info(
      { backend: 'smserver' },
      'SMServer inbound subscription is not implemented yet',
    );
  }

  async send(_chatId: string, _text: string): Promise<void> {
    throw new Error('SMServer adapter send is not implemented yet');
  }

  async resolveChatMeta(_chatId: string): Promise<IMessageChatMeta | null> {
    return null;
  }

  async healthCheck(): Promise<boolean> {
    logger.warn(
      { backend: 'smserver' },
      'SMServer adapter health check returns false (placeholder)',
    );
    return false;
  }
}
