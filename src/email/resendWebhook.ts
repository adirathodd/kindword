// Resend webhook events (https://resend.com/docs/dashboard/webhooks/introduction). Resend signs each event the
// Svix / Standard Webhooks way: base64(HMAC-SHA256(secret, `${svix-id}.${svix-timestamp}.${raw body}`)), where the
// secret is the base64 part of the endpoint's "whsec_…" signing secret, sent as "v1,<signature>" in svix-signature
// (several space-separated when the secret is being rotated). No SDK. Only the event type and the email ID are read;
// the payload's recipient and subject are never returned or logged.
import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_BODY_BYTES = 256 * 1024;
const TOLERANCE_S = 5 * 60; // Svix's default: refuse events signed more than 5 minutes from now (replays)

export type ResendEvent = { type: string; emailId: string | null };

// Reads RESEND_WEBHOOK_SECRET. Throws naming the setting, never its value.
export function resendWebhookSecretFromEnv(env: Record<string, string | undefined> = process.env): Buffer {
  const raw = env.RESEND_WEBHOOK_SECRET?.trim() ?? "";
  const m = /^whsec_([A-Za-z0-9+/]+={0,2})$/.exec(raw);
  const key = m ? Buffer.from(m[1], "base64") : Buffer.alloc(0);
  if (key.length < 16) throw new Error("RESEND_WEBHOOK_SECRET missing or not a whsec_… signing secret");
  return key;
}

export function resendSignature(key: Buffer, id: string, timestamp: string, body: string) {
  return createHmac("sha256", key).update(`${id}.${timestamp}.${body}`, "utf8").digest("base64");
}

function same(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// The event when the request is a correctly signed, recent Resend event; null for anything else.
export async function parseResendEvent(req: Request, key: Buffer, now: Date = new Date()): Promise<ResendEvent | null> {
  if (req.method !== "POST") return null;
  const id = req.headers.get("svix-id");
  const timestamp = req.headers.get("svix-timestamp");
  const signatures = req.headers.get("svix-signature");
  if (!id || !timestamp || !signatures || id.length > 200 || !/^\d{1,12}$/.test(timestamp)) return null;
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > TOLERANCE_S) return null;
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return null;
  const body = await req.text();
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) return null;

  const expected = resendSignature(key, id, timestamp, body);
  const ok = signatures.split(" ").some((s) => s.startsWith("v1,") && same(expected, s.slice(3)));
  if (!ok) return null;

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const o = json as { type?: unknown; data?: { email_id?: unknown } | null } | null;
  if (typeof o?.type !== "string") return null;
  const emailId = typeof o.data?.email_id === "string" ? o.data.email_id : null;
  return { type: o.type, emailId };
}
