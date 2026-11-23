// Email provider boundary (Resend adapter in resend.ts). Tests use a fake; no live emails.
export type EmailMessage = {
  to: string;
  fromName: string; // display name; the sending address comes from the adapter's verified domain
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>; // e.g. List-Unsubscribe
  // Stable key for this one message (e.g. "review-request/<id>"). A repeated send with the same key is not sent again
  // by the provider (Resend keeps keys for 24 hours). Omit it for messages that may legitimately repeat.
  idempotencyKey?: string;
};

export interface EmailProvider {
  // Resolves with the provider's message ID when it has one; throws when the provider refuses the message.
  // Must not log the recipient or the body.
  send(message: EmailMessage): Promise<string | void>;
}
