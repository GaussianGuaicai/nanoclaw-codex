import { logger } from '../../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../../types.js';
import {
  getIMessageConfig,
  IMessageBackend,
  IMessageBackendCallbacks,
  IMessageConfig,
} from './backend.js';
import { BlueBubblesBackend } from './backends/bluebubbles.js';
import { LocalMacOSIMessageBackend } from './backends/local-macos.js';

export interface IMessageChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  config?: IMessageConfig;
  backend?: IMessageBackend;
}

export class IMessageChannel implements Channel {
  name = 'imessage';

  private readonly config: IMessageConfig;
  private readonly backend: IMessageBackend;

  constructor(private readonly opts: IMessageChannelOpts) {
    this.config = opts.config || getIMessageConfig();
    this.backend = opts.backend || this.createBackend(this.config);
  }

  async connect(): Promise<void> {
    try {
      await this.backend.connect();
    } catch (error) {
      logger.error(
        { error, backend: this.config.backend },
        'Failed to connect iMessage channel',
      );
      throw error;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const stableChatId = jid.replace(/^imessage:/, '');
    try {
      await this.backend.sendText(stableChatId, text);
    } catch (error) {
      logger.warn({ error, jid }, 'Failed to send iMessage text');
    }
  }

  isConnected(): boolean {
    return this.backend.isConnected();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('imessage:');
  }

  async disconnect(): Promise<void> {
    await this.backend.disconnect();
  }

  async syncGroups(force: boolean): Promise<void> {
    await this.backend.syncChats(force);
  }

  private createBackend(config: IMessageConfig): IMessageBackend {
    const callbacks: IMessageBackendCallbacks = {
      onMessage: ({ jid, message }) => this.opts.onMessage(jid, message),
      onChatMetadata: (metadata) =>
        this.opts.onChatMetadata(
          metadata.jid,
          metadata.timestamp,
          metadata.name,
          'imessage',
          metadata.isGroup,
        ),
      isRegisteredJid: (jid) => !!this.opts.registeredGroups()[jid],
    };

    if (config.backend === 'bluebubbles') {
      return new BlueBubblesBackend(config, callbacks);
    }

    return new LocalMacOSIMessageBackend(config, callbacks);
  }
}
