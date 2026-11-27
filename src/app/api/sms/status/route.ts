// Twilio message status callback (SPEC FR-17, Flow 4: the monthly report counts messages delivered). Twilio posts
// here for each status change of a text we sent with StatusCallback set (src/sms/twilio.ts). A signed "delivered"
// status for a review request or reminder records one delivery receipt (src/requests/delivery.ts); a signed
// "undelivered" or "failed" status fails the text and, for a request, schedules it by email (FR-6, recordSmsFailure in
// src/requests/requests.ts); every other status, and every message that is not a review request, is acknowledged and
// ignored. Nothing is ever sent from here.
// Logs carry outcome codes only, never phone numbers, message text or SIDs.
import { CARRIER_FAILURE_STATUSES, handleReceipt, type ReceiptStatus } from "../../../../requests/requests";
import { TwilioSms, twilioConfigFromEnv } from "../../../../sms/twilio";

const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

export async function POST(req: Request) {
  let provider: TwilioSms;
  try {
    const config = twilioConfigFromEnv();
    if (!config.statusCallbackUrl) throw new Error("TWILIO_STATUS_CALLBACK_URL not an http(s) URL");
    provider = new TwilioSms(config);
  } catch (e) {
    console.error("sms_status: not configured:", (e as Error).message); // names the setting, never its value
    return new Response("Not configured", { status: 503, headers });
  }

  try {
    const status = await provider.parseStatusCallback(req);
    if (!status) return new Response("Forbidden", { status: 403, headers });
    // "delivered" records a receipt; "undelivered" or "failed" means the text failed, so email instead (FR-6). A
    // receipt that beats the send's record of the message ID is kept and applied by the send (audit O-66-1).
    if (status.status === "delivered" || (CARRIER_FAILURE_STATUSES as readonly string[]).includes(status.status))
      await handleReceipt("sms", status.messageSid, status.status as ReceiptStatus, status.errorCode);
    return new Response(null, { status: 204, headers });
  } catch (e) {
    // A 500 shows in Twilio's error log; the receipt is lost (Twilio does not retry status callbacks): a lower
    // delivered count, or no email fallback for that failed text.
    console.error("sms_status: failed:", e instanceof Error ? e.name : "unknown");
    return new Response("Error", { status: 500, headers });
  }
}
