# Claude Doc edits still needed (SPEC syncs sync-2026-11-24-01, sync-2026-11-25-01 and sync-2026-11-26-01)

Owner decision 2026-11-24 (D-1): the Claude Doc (https://claude.ai/artifact/2MP1j84JD2TXC7B8SwriPs) and `docs/SPEC.md` are always kept in sync. This sync applied its changes to `docs/SPEC.md` in PR #32. The session had no Claude Docs connector, so it could neither read nor write the Doc. Copy these edits into the Doc, then delete this file in the next sync.

## 0. From sync-2026-11-26-01 (PR #42, main 0d0c648)

This session also had no Claude Docs connector, so these edits are in `docs/SPEC.md` only. Copy them into the Doc. This sync also carries the edits of sync-2026-11-25-01 (branch `ccr-b0cc9d2d-e3u0db`, whose PR could not be opened): the FR-2a row text, the FR-24 Node engines pin, and the open items S-5, A-6 and Sheet template dates and tab. That branch is superseded; it can be deleted.

- **Header:** "Last synced against main 0d0c648 on 2026-11-26"; the list of syncs still to copy now includes 2026-11-26.
- **Implementation status:** heading now "on main at 0d0c648 (2026-11-26)". Rows changed:
  - FR-2a: Google Sheets reader as our service account (#37); still no 15-minute schedule.
  - FR-11: Not implemented → Partial (#41): review polling, Business Profile client, encrypted tokens; no schedule, no Google connect step, no manual paste, no 3-hour alert.
  - FR-13: emailed sign-in link option (#36, #38), daily digest and low-rating email (#40); still no scheduler, D-2 open, multi-location link issue (F-40-1).
  - FR-19: sign-in link requests (#36), review fetch, poll failure and owner email audit rows.
  - FR-22: poll now refreshes reviews; still no scheduler.
  - FR-24: sign-up rate-limited per email too (#34); removed from Missing; no Node engines pin added to Missing.
- **Data model:** new `waitlist_entries` row (#33, migration 0009).
- **Decisions needed:** from sync-2026-11-25-01, S-5 (import while onboarding), A-6 (emailed link before verification) and Sheet template dates and tab (FR-2a), before F-7-4; then four new open items after F-7-4: owner emails for multi-location businesses (F-40-1, part of D-2), D-6 drafts for reviews answered on Google, D-7 owner emails and review reads during onboarding, D-8 waitlist scope and retention.

## 1. From sync-2026-11-24-01 (PR #32)

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

The quickest way to sync is to replace the Doc's text with `docs/SPEC.md` from main once #42 merges. The two diagrams exist only in the Doc, so keep them.
