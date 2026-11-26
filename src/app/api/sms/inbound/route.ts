// Inbound SMS webhook (SPEC FR-8, Flow 2 step 4). Twilio posts every text a customer sends to a location's number
// here. Opt-out keywords and phrases suppress the sender at once, at the location and platform-wide, and at most one
// confirmation-only text goes back. The reply is always empty TwiML, so nothing else is ever sent from here.
// Logs carry outcome codes only, never phone numbers or message text.
import { send } from "@vercel/queue";
import { handleInboundSms } from "../../../../optout/optout";
import { TwilioSendError, TwilioSms, twilioConfigFromEnv } from "../../../../sms/twilio";

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

export async function POST(req: Request) {
  let provider: TwilioSms;
  try {
    provider = new TwilioSms(twilioConfigFromEnv());
  } catch (e) {
    console.error("sms_inbound: not configured:", (e as Error).message); // names the setting, never its value
    return new Response("Not configured", { status: 503, headers });
  }

  try {
    const result = await handleInboundSms(provider, req);
    if (result.status === "rejected") return new Response("Forbidden", { status: 403, headers });
    return new Response(EMPTY_TWIML, { status: 200, headers: { ...headers, "Content-Type": "text/xml" } });
  } catch (e) {
    // The opt-out commits before the confirmation is sent, so a failure here never loses the opt-out. A 500 shows
    // in Twilio's error log (11200); a retry finds the opt-out already recorded and sends nothing. The confirmation
    // was recorded with the opt-out, so the optout-confirmations job checks and retries it within 5 minutes
    // (audit F-9-2). Publishing is best effort: a failure before the opt-out committed leaves the job nothing to do.
    await send("jobs", { name: "optout-confirmations" }, { delaySeconds: 60 }).catch((err: unknown) =>
      console.error("sms_inbound: retry not queued:", err instanceof Error ? err.name : "unknown"),
    );
    // TwilioSendError messages hold only the status and Twilio error code; other errors are logged by name only.
    console.error(
      "sms_inbound: failed:",
      e instanceof TwilioSendError ? e.message : e instanceof Error ? e.name : "unknown",
    );
    return new Response("Error", { status: 500, headers });
  }
}
