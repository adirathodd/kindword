// SMS provider boundary (Twilio later). Tests use a fake; no live texts.
export type InboundSms = {
  from: string; // E.164
  to: string; // our number, E.164
  body: string;
  // The provider already opted the sender out and sent its own confirmation. Twilio sets OptOutType=STOP only
  // when Advanced Opt-Out is on for the Messaging Service, so turn it on for every client. If it is off we confirm
  // ourselves and Twilio drops that send (21610), so a second confirmation still can't reach the customer.
  providerHandled: boolean;
};

export interface SmsProvider {
  // Checks the request signature; null when it fails. Must not log the payload.
  parseInbound(req: Request): Promise<InboundSms | null>;
  send(from: string, to: string, body: string): Promise<void>;
}
