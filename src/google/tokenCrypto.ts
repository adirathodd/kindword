// Encryption at rest for Google refresh tokens (SPEC Data model: oauth_tokens "Encrypted at rest; never logged";
// Security: "Google refresh tokens are encrypted at rest"). AES-256-GCM with a key derived from GOOGLE_TOKEN_SECRET,
// which lives in the host's secret store, never in the database. The location ID is bound in as associated data, so
// a token copied onto another location's row does not decrypt.
// The Google connect step (onboarding, Flow 1 step 3) encrypts with encryptRefreshToken; the review poller decrypts.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX = "v1.";

function key(secret: string) {
  if (!secret || secret.length < 32) throw new Error("GOOGLE_TOKEN_SECRET missing or shorter than 32 chars");
  return createHash("sha256").update(`google-refresh-token:v1:${secret}`).digest();
}

export function encryptRefreshToken(refreshToken: string, locationId: string, secret: string) {
  if (!refreshToken) throw new Error("encryptRefreshToken: empty token");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(secret), iv);
  c.setAAD(Buffer.from(locationId, "utf8"));
  const body = Buffer.concat([c.update(refreshToken, "utf8"), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
}

// Null when the value was tampered with, belongs to another location, or was encrypted with another secret. Never
// throws with the token or the secret in the message.
export function decryptRefreshToken(encrypted: string, locationId: string, secret: string): string | null {
  const k = key(secret);
  if (!encrypted.startsWith(PREFIX)) return null;
  const raw = Buffer.from(encrypted.slice(PREFIX.length), "base64url");
  if (raw.length < 29) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", k, raw.subarray(0, 12));
    d.setAAD(Buffer.from(locationId, "utf8"));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8") || null;
  } catch {
    return null;
  }
}
