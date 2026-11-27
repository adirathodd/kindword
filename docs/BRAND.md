# Kindword brand and UI guide

Every page Kindword shows follows this guide: the landing page, the owner inbox, the account pages, emails and anything built later. The reference is the landing page as shipped (`public/landing/index.html`, design option C, chosen 2026-11-23). When this guide and a page disagree, fix the page or change this guide on purpose in the same PR.

## Tokens

One source: `src/ui/brand.ts`. `src/app/globals.css` and the landing page's `:root` carry the same values, and `src/ui/brand.test.ts` fails when they drift. Server-rendered pages (inbox, account) get the tokens as `--k-*` CSS variables through `BRAND_CSS_VARS`. Never write a colour, font or radius by hand; add a token first.

| Token                    | Value                 | Use                                                         |
| ------------------------ | --------------------- | ----------------------------------------------------------- |
| `bg`                     | `#f7f9f8`             | Page background (off-white)                                 |
| `surface`                | `#ebf0ee`             | Panels, quiet fills, secondary buttons, the reply box       |
| `card`                   | `#ffffff`             | Cards and form fields on the background                     |
| `ink`                    | `#06525c`             | Deep teal: all text, primary buttons, links, focus ring     |
| `muted`                  | `#2f737d`             | Labels, dates, meta and form-field borders; never body text |
| `inkOn`                  | `#f7f9f8`             | Text on a filled teal button                                |
| `line`                   | `rgb(6 82 92 / 0.14)` | Hairlines and borders                                       |
| `warnBg` / `warnLine`    | `#fff4e5` / `#f0b46c` | "Needs extra care" on a held draft                          |
| `okBg` / `okLine`        | `#e8f4ea` / `#7fbf8a` | A notice that something worked                              |
| `errorBg` / `errorLine`  | `#fdecea` / `#e08a83` | An error the owner must fix                                 |
| `alert`                  | `#b3261e`             | The overdue badge only                                      |
| `radiusSm` / `Md` / `Lg` | 4 / 6 / 8 px          | Chips; buttons and fields; cards and windows                |

**Colour rules.** The interface is about 95% neutral: teal on off-white, one accent (the teal itself). Status colours only mark state. No violet or lavender, no gradients or glows in page backgrounds (a fade at the foot of a UI mock is fine), no dark mode for now.

## Type

- **Host Grotesk** for everything, weights 400 and 500 only (never bold). Headlines at 500 with tight tracking (-0.02 to -0.04em at large sizes).
- **JetBrains Mono** only for small UI labels and numbers inside product mocks ("Step 1", timestamps).
- Sentence case everywhere. Labels 13px or larger; text people read 16px or larger.
- The landing page loads both fonts from Google Fonts. The React layout self-hosts them with `next/font`. Owner pages (inbox, account) have a CSP that blocks web fonts, so they fall back to the system font until the font is self-hosted under `/public` with `font-src 'self'`.

## Layout (marketing pages)

- One idea per section; each section fills exactly one or two screens. The hero is alone on the first screen.
- Content on one 1280px column with 12 columns and 24px gutters; every block starts on the left line and ends on the right one. Splits use one shared split line: text left, visual right, never mirrored.
- Pictures show the real product: the approval inbox, the review-request text, the job list, the setup checklist. Product mocks are live HTML, not screenshots. Photographs only of real customers' businesses, with permission; no stock people.
- Owner pages (inbox, account) are single-column, max 44rem, plain forms, no scripts.

## Components

- **Buttons:** one filled teal primary per screen for the main action; everything else is the tonal secondary (surface fill, teal text). 44px tall on marketing pages; corners `radiusMd`. Labels are a verb plus the object ("Request a setup call", "Approve", "Save and approve").
- **Cards:** white on the background with a `line` border and `radiusLg`; never a box inside a box inside a box.
- **Chips:** small rounded labels for status ("Draft", "Posted", "Needs you", "Opted out").
- **App window:** the inbox mock: list of reviews on the left, the open draft with Approve, Edit and Reject on the right, and the reply checks under it.
- **Focus:** a 2px teal outline on every focusable element, shown at once.
- **Sign-in pages** (sign-up, sign-in, sign-in link, reset): one narrow card under the wordmark, a "Back to …" text link at the top, fields with `muted` borders (3:1 against white), errors under the field they belong to, and other ways in as tonal secondary buttons under the primary.

## Voice

- Short, factual, technical-dry. Say what Kindword does in words a business owner would say out loud. "We" for the work, "you" for what the owner gets; Kindword is the subject of feature lines.
- Headlines name the thing (the product, a part, a section) and never ask a question. One plain fact on the first screen (a price, a count, a time).
- No filler words (seamless, powerful, effortless, unlock, elevate…), no virtue words about ourselves (honest, simply, actually), no exclamation marks, no puns.
- Audience: local businesses in general. Don't name a region or a trade on public pages.
- Never invent proof: no made-up reviews, quotes, ratings, customer names, logos or statistics. Mocks use initials, star ratings and states, not review text.
- Product copy must match the spec: no promise of a number of reviews or a rating, and say plainly that every reply waits for the owner's approval.

## What the UI must never do

These come from the spec's hard constraints and apply to every screen and message:

- No review gating: never a "how did we do?" step before the review link, and no different path for happy and unhappy customers.
- No incentives, staff names or requests for specific content in anything sent to customers.
- No reply posts without an explicit owner action; the approve button always says what happens.
- Every text includes "Reply STOP to opt out".

## Changing the brand

Change `src/ui/brand.ts`, `src/app/globals.css` and the landing page's `:root` together (the test enforces it), update this file, and say why in the PR.
