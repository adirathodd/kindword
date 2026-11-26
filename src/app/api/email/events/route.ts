// Resend webhook (SPEC FR-17, Flow 4: the monthly report counts messages delivered). Subscribe the endpoint to
// email.delivered in Resend and put its signing secret in RESEND_WEBHOOK_SECRET. A signed email.delivered event for a
// review request or reminder records one delivery receipt (src/requests/delivery.ts); every other event, and every
// email that is not a review request (owner emails), is acknowledged and ignored. Nothing is ever sent from here.
// Logs carry outcome codes only, never addresses, subjects or email IDs.
import { parseResendEvent, resendWebhookSecretFromEnv } from "../../../../email/resendWebhook";
import { recordDelivery } from "../../../../requests/delivery";

const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

export async function POST(req: Request) {
  let key: Buffer;
  try {
    key = resendWebhookSecretFromEnv();
  } catch (e) {
    console.error("email_events: not configured:", (e as Error).message); // names the setting, never its value
    return new Response("Not configured", { status: 503, headers });
  }

  try {
    const event = await parseResendEvent(req, key);
    if (!event) return new Response("Forbidden", { status: 403, headers });
    if (event.type === "email.delivered" && event.emailId) await recordDelivery("email", event.emailId);
    return new Response(null, { status: 204, headers });
  } catch (e) {
    // Resend retries a failed delivery of the event with backoff, and a repeat is recorded once.
    console.error("email_events: failed:", e instanceof Error ? e.name : "unknown");
    return new Response("Error", { status: 500, headers });
  }
}
