import { describe, expect, it } from "vitest";
import { pickLanguage, reviewEmail, smsBody } from "./messages";

const LINK = "https://app.example.test/r/00000000-0000-4000-8000-000000000001";

describe("review request wording (FR-7)", () => {
  it.each([1, 2] as const)("SMS attempt %i names the business, has the link and the STOP line", (attempt) => {
    for (const lang of ["en", "es"] as const) {
      const body = smsBody(lang, attempt, "Acme Plumbing", LINK);
      expect(body).toContain("Acme Plumbing");
      expect(body).toContain(LINK);
      expect(body.endsWith("Reply STOP to opt out.")).toBe(true);
    }
  });

  it("never offers an incentive or asks for specific content", () => {
    const all = (["en", "es"] as const).flatMap((l) => [smsBody(l, 1, "B", LINK), smsBody(l, 2, "B", LINK)]);
    for (const body of all) expect(body).not.toMatch(/discount|coupon|gift|free|5 stars|five stars|mention|descuento/i);
  });

  it("the reminder differs from the request", () => {
    expect(smsBody("en", 2, "B", LINK)).not.toEqual(smsBody("en", 1, "B", LINK));
    expect(smsBody("en", 2, "B", LINK)).toMatch(/reminder/);
  });

  it("picks Spanish for es and es-* and English for anything else", () => {
    expect(pickLanguage("es")).toBe("es");
    expect(pickLanguage("ES-us")).toBe("es");
    expect(pickLanguage("es_MX")).toBe("es");
    expect(pickLanguage("fr")).toBe("en");
    expect(pickLanguage(null)).toBe("en");
    expect(pickLanguage("")).toBe("en");
  });
});

describe("review request email (FR-6, CAN-SPAM)", () => {
  const args = {
    lang: "en" as const,
    attempt: 1 as const,
    business: `Bob's <Pipes> & Co`,
    to: "pat@example.test",
    link: LINK,
    unsubscribeUrl: "https://app.example.test/u/tok",
    postalAddress: "PO Box 1, Hoboken, NJ 07030",
  };

  it("carries the link, an unsubscribe link and the postal address in text and HTML", () => {
    const m = reviewEmail(args);
    for (const part of [m.text, m.html]) {
      expect(part).toContain(LINK);
      expect(part).toContain("https://app.example.test/u/tok");
      expect(part).toContain("PO Box 1, Hoboken, NJ 07030");
    }
    expect(m.to).toBe("pat@example.test");
    expect(m.fromName).toBe(args.business);
  });

  it("sets one-click unsubscribe headers", () => {
    expect(reviewEmail(args).headers).toEqual({
      "List-Unsubscribe": "<https://app.example.test/u/tok>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  it("escapes the business name in HTML", () => {
    const { html } = reviewEmail(args);
    expect(html).toContain("Bob&#39;s &lt;Pipes&gt; &amp; Co");
    expect(html).not.toContain("<Pipes>");
  });

  it("writes Spanish when asked", () => {
    const m = reviewEmail({ ...args, lang: "es" });
    expect(m.subject).toMatch(/reseña/);
    expect(m.html).toContain('lang="es"');
  });
});
