export type IMessageInboundEventType =
  | 'message'
  | 'receipt'
  | 'edit'
  | 'retract';

export type IMessageInboundMessageType =
  | 'text'
  | 'image'
  | 'video'
  | 'voice'
  | 'audio'
  | 'attachment'
  | 'sticker'
  | 'location'
  | 'contact'
  | 'system';

export interface IMessageInboundEvent {
  platformMessageId: string;
  chatId: string;
  sender: string;
  senderName?: string;
  timestamp: string;
  type?: IMessageInboundEventType;
  messageType?: IMessageInboundMessageType;
  content?: string;
  attachmentName?: string;
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
