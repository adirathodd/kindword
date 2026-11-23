// SMS provider boundary (Twilio later). Tests use a fake; no live texts.
export type InboundSms = {
  from: string; // E.164
  to: string; // our number, E.164
  body: string;
  providerHandled: boolean; // the provider already opted the sender out and sent its own confirmation (Twilio OptOutType=STOP)
};

export interface SmsProvider {
  // Checks the request signature; null when it fails. Must not log the payload.
  parseInbound(req: Request): Promise<InboundSms | null>;
  send(from: string, to: string, body: string): Promise<void>;
}
