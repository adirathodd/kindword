import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword, passwordProblem, PwnedPasswords, verifyPassword } from "./password";

describe("password hashing", () => {
  it("stores an Argon2id PHC string that verifies only the same password", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(h).not.toContain("correct");
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("correct horse batterY", h)).toBe(false);
    expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
    expect(await hashPassword("correct horse battery")).not.toBe(h); // fresh salt
  });

  it("requires 12 to 256 characters", () => {
    expect(passwordProblem("short")).toMatch(/at least 12/);
    expect(passwordProblem("x".repeat(257))).toMatch(/at most 256/);
    expect(passwordProblem("twelve chars")).toBeNull();
  });
});

describe("breached-password check", () => {
  const pw = "password1234";
  const sha1 = createHash("sha1").update(pw).digest("hex").toUpperCase();
  const fakeFetch = (body: string, seen: string[] = []) =>
    (async (url: string) => {
      seen.push(url);
      return new Response(body);
    }) as unknown as typeof fetch;

  it("sends only the 5-character hash prefix and matches the suffix", async () => {
    const seen: string[] = [];
    const breached = await new PwnedPasswords(fakeFetch(`AAAA:1\r\n${sha1.slice(5)}:42\r\n`, seen)).isBreached(pw);
    expect(breached).toBe(true);
    expect(seen).toEqual([`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`]);
  });

  it("ignores padding rows and fails open when the service is down", async () => {
    expect(await new PwnedPasswords(fakeFetch(`${sha1.slice(5)}:0\r\n`)).isBreached(pw)).toBe(false);
    const down = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await new PwnedPasswords(down).isBreached(pw)).toBe(false);
  });
});
