export interface SendRequest {
  to: string;
  fromName: string;
  fromEmail: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  /** RFC822 Message-ID to set on this outbound message. */
  messageId?: string;
  /** Message-ID this email replies to (threads follow-ups in the inbox). */
  inReplyTo?: string;
  references?: string;
  headers?: Record<string, string>;
}

export interface SendResult {
  /** The Message-ID header that ended up on the sent email. */
  messageId: string;
  accepted: boolean;
  detail?: string;
}

export interface EmailSender {
  readonly name: string;
  verify(): Promise<boolean>;
  send(req: SendRequest): Promise<SendResult>;
}
