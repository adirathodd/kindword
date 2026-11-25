# Claude Doc edits still needed (SPEC syncs sync-2026-11-24-01 and sync-2026-11-25-01)

Owner decision 2026-11-24 (D-1): the Claude Doc (https://claude.ai/artifact/2MP1j84JD2TXC7B8SwriPs) and `docs/SPEC.md` are always kept in sync. This sync applied its changes to `docs/SPEC.md` in PR #32. The session had no Claude Docs connector, so it could neither read nor write the Doc. Copy these edits into the Doc, then delete this file in the next sync. Sync sync-2026-11-25-01 also had no Claude Docs connector (the Doc's link resolves, but its content is readable only through that connector), so none of the edits below have been checked against the Doc.

## 0. From sync-2026-11-25-01 (this PR, main b822c46)

- **Header:** "last synced against main b822c46 on 2026-11-25"; the list of edits still to copy now includes the 2026-11-25 sync.
- **Implementation status:** heading now "on main at b822c46 (2026-11-25)". Rows changed: FR-2a (#37 Sheets reader; schedule and operator surface still missing; template dates), FR-13 (#36 emailed-link page; F-36-1 noncompliant until #38 merges; D-2 and digest still missing), FR-19 (sign-in link requests audited), FR-24 (#34 per-email sign-up limit done; F-28-5 noncompliant until #38 merges; Node engines pin missing). Copy those four rows from `docs/SPEC.md`.
- **Decisions needed:** three new open items before F-7-4: S-5 (import while onboarding), A-6 (emailed link before verification) and Sheet template dates and tab (FR-2a, O-37-1). Copy them from `docs/SPEC.md`.

## 1. From sync-2026-11-24-01 (PR #32, merged)

- **Header:** the source-of-truth note in `docs/SPEC.md` now says the file is kept in sync with the Doc and was last synced against main ca05c82 on 2026-11-24. Add a matching note to the Doc, or leave it out if the Doc doesn't carry one.
- **Implementation status:** the section now reads "Status of each requirement on main at ca05c82 (2026-11-24)". It has new rows for FR-1, FR-6, FR-8, FR-12, FR-13, FR-14, FR-19, FR-23 and FR-24. Copy the whole section from `docs/SPEC.md`.
- **Data model:** two new tables, `account_sessions` and `auth_attempts`. `owner_sessions` gains `account_id`.
- **Decisions needed:** D-1 (decided) and the open items D-2, D-3, D-4, D-5 and F-7-4.

## 2. Earlier edits made only in `docs/SPEC.md`, after the Doc export (rev 244)

I couldn't read the Doc, so I couldn't check which of these are already in it. Notion says the Kindword heading and Overview already are.

- **PR #11:**
  - FR-13 and Flow 3 step 4: home-page sign-in screen, and approved replies waiting to post.
  - Data-model fields: `skip_reason` clicked, `session_token_hash`, `reply_drafts.created_at`, and the `sheet_sources` consent fields.
  - The Implementation status section.
  - Open decisions on sheet row IDs (A-1, A-2), request languages and reminder staleness.
- **PR #13:**
  - AI provider: Groq free tier by default, Claude Haiku 5.5 as the paid fallback, plus the provider research notes.
  - Quality checks.
  - `businesses.approved_facts`.
- **PR #25:** Kindword brand in the title, the Overview and a Brand line.
- **PR #27:**
  - Self-serve sign-up: the change note, Scope, Flow 0, Flow 1 step 1, FR-13 and FR-24.
  - The `owner_accounts` and `account_tokens` tables.
  - Design choices and Security lines.
  - Two risks.
  - The Week 2 gate.
  - The Self-serve signup decision.

The quickest way to sync is to replace the Doc's text with `docs/SPEC.md` from main once #32 merges. The two diagrams exist only in the Doc, so keep them.
