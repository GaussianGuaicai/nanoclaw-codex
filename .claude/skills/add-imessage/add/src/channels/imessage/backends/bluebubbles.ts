import { logger } from '../../../logger.js';
import {
  IMessageBackend,
  IMessageBackendCallbacks,
  IMessageConfig,
} from '../backend.js';

export class BlueBubblesBackend implements IMessageBackend {
  private connected = false;

  constructor(
    private readonly _config: IMessageConfig,
    private readonly _callbacks: IMessageBackendCallbacks,
  ) {}

  async connect(): Promise<void> {
    logger.error(
      'IMESSAGE_BACKEND=bluebubbles is not implemented yet. Apply the add-imessage skill for the stable channel contract now, and wire the transport later in src/channels/imessage/backends/bluebubbles.ts.',
    );
    throw new Error('BlueBubbles backend not implemented yet');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async sendText(_stableChatId: string, _text: string): Promise<void> {
    throw new Error('BlueBubbles backend not implemented yet');
  }

  async syncChats(_force: boolean): Promise<void> {
    logger.warn('BlueBubbles chat sync requested before implementation');
  }

  async startPolling(): Promise<void> {
    logger.warn('BlueBubbles polling requested before implementation');
  }
}
