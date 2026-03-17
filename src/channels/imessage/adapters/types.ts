export interface IMessageInboundEvent {
  id: string;
  chatId: string;
  sender: string;
  senderName?: string;
  content: string;
  timestamp: string;
  isFromMe?: boolean;
}

export interface IMessageChatMeta {
  name?: string;
  isGroup?: boolean;
}

export interface IMessageAdapter {
  connect(): Promise<void>;
  subscribeInbound(
    handler: (event: IMessageInboundEvent) => void,
  ): Promise<void>;
  send(chatId: string, text: string): Promise<void>;
  resolveChatMeta(chatId: string): Promise<IMessageChatMeta | null>;
  healthCheck(): Promise<boolean>;
}
