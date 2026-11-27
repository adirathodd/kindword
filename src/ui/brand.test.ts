import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { html } from "../inbox/http";
import { BRAND, BRAND_CSS_VARS } from "./brand";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("brand tokens", () => {
  it("globals.css carries the same core values as brand.ts", () => {
    const css = read("src/app/globals.css");
    for (const [name, v] of [
      ["bg", BRAND.bg],
      ["surface", BRAND.surface],
      ["card", BRAND.card],
      ["ink", BRAND.ink],
      ["muted", BRAND.muted],
      ["ink-on", BRAND.inkOn],
      ["line", BRAND.line],
      ["radius-sm", BRAND.radiusSm],
      ["radius-md", BRAND.radiusMd],
      ["radius-lg", BRAND.radiusLg],
    ])
      expect(css).toContain(`--k-${name}: ${v};`);
  });

  it("the landing page uses the same palette when it is present", () => {
    const path = new URL("../../public/landing/index.html", import.meta.url);
    if (!existsSync(path)) return; // the landing page ships in its own PR
    const page = readFileSync(path, "utf8");
    for (const v of [BRAND.bg, BRAND.surface, BRAND.ink, BRAND.muted]) expect(page).toContain(v);
  });

  it("the landing page links owners to /account to sign in (D-2, FR-13)", () => {
    const page = read("public/landing/index.html");
    expect(page).toMatch(/<div class="nav__actions">\s*<a class="nav__link" href="\/account">Sign in<\/a>/);
  });

  it("owner pages get every token and no colours of their own", async () => {
    const body = await html(200, "Test", "<p>x</p>").text();
    expect(body).toContain(BRAND_CSS_VARS);
    const css = body.slice(body.indexOf("<style>") + 7, body.indexOf("</style>")).replace(BRAND_CSS_VARS, "");
    expect(css.match(/#[0-9a-f]{3,6}\b/gi) ?? []).toEqual(["#fff"]); // white text on the overdue badge only
  });
});
