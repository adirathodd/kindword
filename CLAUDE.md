# Kindword (working name: Review & Reputation Automation Service)

Solo, nights-and-weekends side business, brand name **Kindword**: a done-for-you Google review request service plus AI-drafted, owner-approved review replies and a monthly report, for local home-services businesses (NJ first, then NYC). The goal is a low-overhead recurring-revenue business a larger reputation-management company would want to buy. Keep scope small. Avoid anything that needs constant attention.

## Source of truth

- The spec lives in two places that are always kept in sync (owner decision 2026-11-24): `docs/SPEC.md` in the repo, which sessions and scheduled routines read, and the Claude Doc at https://claude.ai/artifact/2MP1j84JD2TXC7B8SwriPs. Any other SPEC file or export is an old snapshot; ignore it.
- Every SPEC change lands in both. Change `docs/SPEC.md` by PR and make the same edit in the Doc; if the Doc is edited first, re-export it to `docs/SPEC.md` by PR. A session that cannot write to the Doc lists the edits the Doc still needs in the PR and in Notion, so the owner can apply them.
- If the spec looks wrong, incomplete, or conflicts with Google or Twilio policy or the law, stop and say so. Don't work around it or change the intended behavior to match the code; the owner decides.

## Decisions already made (do not reopen unless asked)

- Vertical: home services only. No healthcare (HIPAA/BAA) or finance clients.
- Stack: TypeScript + Next.js (App Router), Postgres with Drizzle ORM, hosted queue/scheduler, Twilio (10DLC per client), Resend, Claude API.
- Intake: CSV and a shared Google Sheet only. The webhook and job-software integrations come later.
- Google Business Profile API with a manual-posting fallback.
- Self-serve owner signup with email and password (FR-24); the emailed sign-in link stays as an alternative. A new signup waits in onboarding, and nothing sends until the operator switches it to live.
- Owner approval inbox with a daily digest.
- One reminder to non-clickers, at most 2 messages per job. Email only when there is no phone with consent or the text fails, never both.
- No public AI label on replies. The contract discloses AI drafting and the owner approves every reply.

## Hard constraints (every design and code decision)

- Never store a phone number without a consent record. Enforce it in the database, not only in code.
- Purge review text, reviewer names and anything derived from them (including drafts) within 30 days of fetch. Don't store rating averages or review counts from reviews.
- Never post a reply without explicit owner approval. Replies on a client's behalf need the client's written authorization.
- No review gating: ask every eligible customer the same way, never filter by expected sentiment, no incentives, no staff names or content requests.
- Treat review-request texts as promotional (prior express written consent). Honor STOP, revoke, opt out, cancel and unsubscribe immediately, both per client and platform-wide, including retries and future imports.
- Send texts only between 9 a.m. and 8 p.m. in the location's time zone.
- Keep phone numbers, message text and review text out of application logs.

## How to work

- Build in small steps that match the spec's milestones (Week 1-4 gates). Do one step per session: open a PR with the test results, then stop for review.
- Lead with the answer and keep explanations short.
- All UI, emails and customer-facing copy follow `docs/BRAND.md`. Use the tokens in `src/ui/brand.ts`; never hand-write a colour, font or radius.
- Use no real customer data, send no live texts or emails, and create no outside accounts (Twilio, Google, Resend) until the owner says so. Hosting (Vercel) is set up by the owner; don't change its settings or env vars unless asked. Put each outside service behind a small interface and use fakes in tests.
- Every job must be idempotent: a retry never sends the same message twice.
- Don't use Bloomberg equipment, accounts or information for this project.
- Not legal or tax advice. Flag anything a lawyer or accountant should check rather than guessing.

## Git and deploy

- Merging to `main` deploys to production on Vercel. Every PR gets a Vercel preview deployment.
- Never commit or push to `main`. Work on a branch (`feat/...`, `fix/...`, `chore/...`), open a PR, and squash-merge only when the `check` CI job is green and the owner has approved. Branch protection enforces this.
- Before opening a PR, run `npm run format:check && npm run lint && npm test && npm run build` locally.
- Every schema change ships as a generated Drizzle migration (`npm run db:generate`) committed in the same PR. Never edit an applied migration.
- Migrations run on production after merge (`.github/workflows/migrate.yml`), possibly after the new code is live. Keep them backward-compatible: add columns and tables first, drop or rename only in a later PR once no deployed code uses them.
- Preview deployments must never have live Twilio, Resend or AI keys, and never point at the production database.
- No secrets in code, commits, PR text or logs. `.env` stays local; `.env.example` lists every variable with no values.
