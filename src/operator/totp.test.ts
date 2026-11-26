// RFC 6238 authenticator codes (SPEC Security: operator two-factor authentication). No network, no database.
import { describe, expect, it } from "vitest";
import { base32Encode, generateTotpSecret, otpauthUri, totpCode, verifyTotp, TOTP_PERIOD_S } from "./totp";

// RFC 6238 Appendix B test key (SHA-1): ASCII "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));
const at = (s: number) => new Date(s * 1000);

describe("totp", () => {
  it("matches the RFC 6238 SHA-1 test vectors (last 6 digits)", () => {
    expect(totpCode(RFC_SECRET, Math.floor(59 / TOTP_PERIOD_S))).toBe("287082");
    expect(totpCode(RFC_SECRET, Math.floor(1111111109 / TOTP_PERIOD_S))).toBe("081804");
    expect(totpCode(RFC_SECRET, Math.floor(1234567890 / TOTP_PERIOD_S))).toBe("005924");
  });

  it("accepts the current code and one step either side, and returns the step used", () => {
    const now = 1_800_000_000;
    const step = Math.floor(now / TOTP_PERIOD_S);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step), at(now))).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), at(now))).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), at(now))).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), at(now))).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 2), at(now))).toBeNull();
  });

  it("refuses malformed codes and secrets", () => {
    const now = at(1_800_000_000);
    for (const code of ["", "12345", "1234567", "abcdef", " 123456", "12 456"])
      expect(verifyTotp(RFC_SECRET, code, now)).toBeNull();
    expect(verifyTotp("not base32!", "123456", now)).toBeNull();
  });

  it("generates a 160-bit base32 secret and an otpauth URI for authenticator apps", () => {
    const a = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateTotpSecret()).not.toBe(a);
    const uri = otpauthUri(a, "ops@example.test");
    expect(uri).toBe(
      `otpauth://totp/Kindword:ops%40example.test?secret=${a}&issuer=Kindword&algorithm=SHA1&digits=6&period=30`,
    );
  });
});
