import { describe, expect, it } from "vitest";
import { decryptRefreshToken, encryptRefreshToken } from "./tokenCrypto";

const SECRET = "test-only-google-token-secret-0123456789";
const LOC = "6f1c2a8e-1111-4222-8333-944455556666";

describe("refresh token encryption", () => {
  it("round-trips without the token appearing in the stored value", () => {
    const enc = encryptRefreshToken("1//refresh-token-value", LOC, SECRET);
    expect(enc.startsWith("v1.")).toBe(true);
    expect(enc).not.toContain("refresh-token-value");
    expect(Buffer.from(enc.slice(3), "base64url").toString("latin1")).not.toContain("refresh-token-value");
    expect(decryptRefreshToken(enc, LOC, SECRET)).toBe("1//refresh-token-value");
    expect(encryptRefreshToken("1//refresh-token-value", LOC, SECRET)).not.toBe(enc); // fresh IV each time
  });

  it("does not decrypt for another location, another secret, or a tampered value", () => {
    const enc = encryptRefreshToken("rt", LOC, SECRET);
    expect(decryptRefreshToken(enc, "6f1c2a8e-0000-4222-8333-944455556666", SECRET)).toBeNull();
    expect(decryptRefreshToken(enc, LOC, `${SECRET}-other`)).toBeNull();
    const raw = Buffer.from(enc.slice(3), "base64url");
    raw[raw.length - 1] ^= 1;
    expect(decryptRefreshToken(`v1.${raw.toString("base64url")}`, LOC, SECRET)).toBeNull();
    expect(decryptRefreshToken("plaintext-token", LOC, SECRET)).toBeNull();
    expect(decryptRefreshToken("v1.abc", LOC, SECRET)).toBeNull();
  });

  it("refuses a missing or short secret", () => {
    expect(() => encryptRefreshToken("rt", LOC, "short")).toThrow("GOOGLE_TOKEN_SECRET missing or shorter than 32");
    expect(() => decryptRefreshToken("v1.x", LOC, "")).toThrow("GOOGLE_TOKEN_SECRET");
  });
});
