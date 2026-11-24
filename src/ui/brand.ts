// Kindword brand tokens: the one source for colours, type and corners on every page we render.
// The landing page (public/landing/index.html, :root) and src/app/globals.css carry the same values;
// brand.test.ts fails when they drift. Rules for using them: docs/BRAND.md.

export const BRAND = {
  bg: "#f7f9f8", // off-white page ground
  surface: "#ebf0ee", // panels, quiet fills
  card: "#ffffff", // cards and form fields on the ground
  ink: "#06525c", // deep teal: text, buttons, links, focus
  muted: "#2f737d", // labels and meta only (5.1:1 on bg), never body text
  inkOn: "#f7f9f8", // text on a filled ink button
  line: "rgb(6 82 92 / 0.14)", // hairlines and borders
  // status colours (owner pages): used only to mark state, never as decoration
  warnBg: "#fff4e5",
  warnLine: "#f0b46c",
  okBg: "#e8f4ea",
  okLine: "#7fbf8a",
  errorBg: "#fdecea",
  errorLine: "#e08a83",
  alert: "#b3261e", // overdue badge
  font: '"Host Grotesk", system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: '"JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, monospace',
  radiusSm: "4px",
  radiusMd: "6px",
  radiusLg: "8px",
} as const;

const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** `:root{--k-bg:…}`: every token as a CSS custom property, for server-rendered pages. */
export const BRAND_CSS_VARS = `:root{${Object.entries(BRAND)
  .map(([k, v]) => `--k-${kebab(k)}:${v}`)
  .join(";")}}`;
