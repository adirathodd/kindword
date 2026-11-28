// Authenticator-app codes for the operator's second factor (SPEC Security: "Operator login uses a strong password plus
// two-factor authentication"). RFC 6238 TOTP with the defaults every authenticator app supports: HMAC-SHA1, 6 digits,
// 30-second steps. node:crypto only, no dependency. The secret is base32 (RFC 4648), as authenticator apps expect.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TOTP_PERIOD_S = 30;
const DIGITS = 6;
const DRIFT_STEPS = 1; // accept one step either side of now for clock drift
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

// Null for anything that is not base32 (padding and spaces allowed, case-insensitive).
export function base32Decode(s: string): Buffer | null {
  const clean = s.replace(/[\s=]/g, "").toUpperCase();
  if (!clean || /[^A-Z2-7]/.test(clean)) return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    value = (value << 5) | ALPHABET.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// A new 160-bit secret (RFC 4226's recommended length), base32.
export const generateTotpSecret = () => base32Encode(randomBytes(20));

export function totpCode(secret: string, step: number): string {
  const key = base32Decode(secret);
  if (!key) throw new Error("TOTP secret is not base32");
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", key).update(counter).digest();
  const offset = h[h.length - 1] & 15;
  const bin = (h.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(bin).padStart(DIGITS, "0");
}

// The time step the code belongs to (now, or one step either side), or null. The caller stores the step so the
// same code can never be used twice.
export function verifyTotp(secret: string, code: string, now: Date): number | null {
  if (!/^[0-9]{6}$/.test(code) || !base32Decode(secret)) return null;
  const current = Math.floor(now.getTime() / 1000 / TOTP_PERIOD_S);
  let match: number | null = null;
  for (let step = current - DRIFT_STEPS; step <= current + DRIFT_STEPS; step++) {
    // Compare every candidate in constant time, so timing never says which step matched.
    if (timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(code)) && match === null) match = step;
  }
  return match;
}

// For the authenticator app's QR code or manual entry. Shown once by the setup script, never stored or logged.
export const otpauthUri = (secret: string, account: string) =>
  `otpauth://totp/Kindword:${encodeURIComponent(account)}?secret=${secret}&issuer=Kindword&algorithm=SHA1&digits=${DIGITS}&period=${TOTP_PERIOD_S}`;
