# Claude Doc edits still needed

The Claude Doc (https://claude.ai/artifact/2MP1j84JD2TXC7B8SwriPs) was last brought level with `docs/SPEC.md` at main 33bea94 (Doc rev 268). These later PRs changed `docs/SPEC.md` only, mostly in the **Implementation status** table:

| PR                                                      | Rows                                                                                         |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| #44 (job scheduler)                                     | FR-2a, FR-5, FR-6, FR-11, FR-12, FR-13, FR-22                                                |
| #53 (monthly report)                                    | FR-17                                                                                        |
| #58 (status after #54 operator alerts and #55 Node pin) | FR-11, FR-19, FR-24                                                                          |
| sync-2026-11-26-02 (SPEC sync at main f3d6d49)          | FR-2, FR-7, FR-17, FR-23, new Retention (Security) row                                       |
| #72 (opt-out confirmation, F-9-2)                       | FR-8                                                                                         |
| sync-2026-11-26-04 (SPEC sync at main 9f7a119, #74)     | FR-5, FR-6, FR-7, FR-8, FR-9, FR-13, FR-17, FR-19, FR-20, FR-23, FR-24, Retention (Security) |
| sync-2026-11-26-05 (SPEC sync at main 6a3b21d)          | FR-8, FR-13, FR-17, FR-19                                                                    |
| D-19 carrier-failure fallback (audit-2026-11-26-04)     | FR-6, FR-17, FR-19                                                                           |

sync-2026-11-26-02 also changed two lines outside the table: the header line ("Last synced against main f3d6d49") and a new item under **Decisions needed**, "Consent evidence retention (D-13, …)", added after D-12.

Simplest fix: replace the Doc's text with `docs/SPEC.md` from main and keep the two diagrams. The sessions that made these edits had no Claude Docs connector, so the owner applies them (CLAUDE.md, Source of truth).

#69 also changed FR-9's requirement text (a duplicate skip stays skipped) and marked the F-7-4 item under **Decisions needed** decided.

sync-2026-11-26-04 also changed, outside the table: the header line (then 9f7a119); the **Data model** rows for businesses (offboarded\_at) and review\_requests (outcome\_unknown, send\_attempts, maybe\_sent\_at) and a new optout\_confirmations row; under **Decisions needed**, the F-40-1 item is marked resolved by #68, and the D-11 item says F-9-2 is fixed by #72. Doc rev 279 already has #73's FR-13 row, which still lists F-40-1 as missing and the D-2 entry point as "Missing"; this PR's FR-13 row replaces it (F-40-1 fixed by #68), and the F-40-1 item is now ticked.

sync-2026-11-26-05 also moved the header line to 6a3b21d.

sync-2026-11-27-01 (SPEC sync at main 113f99f) moved the header line to 113f99f and the first sentence under **Implementation status** to "Status of each requirement on main at 113f99f (2026-11-27)." No row changed.

When a later PR changes `docs/SPEC.md`, make the same edit in the Doc, or list it here.

The D-2 and multi-business accounts PR (2026-11-26: change note, FR-13, new FR-25 and its status row, account\_businesses in the Data model, the Security scoping line, the Week 2 gate, D-2 decided, the F-40-1 note, new items D-14 to D-18) was applied to the Doc directly (Doc rev 279) and needs no further Doc edit. In the Doc, D-14 to D-18 sit at the end of the list, where D-13 will also go once the items above are applied.

The D-19 PR (audit-2026-11-26-04, owner decision 2026-11-27) also changed, outside the table: FR-6's requirement text (adds "a text Twilio accepted but later reports undelivered or failed counts as failed (decided 2026-11-27, D-19)" before "; email carries") and a new ticked item under **Decisions needed**, "Carrier failure after Twilio accepts a text (D-19, FR-6)", after D-18. The same PR (audit fixes O-66-1, O-66-3, O-62-1) also adds two **Data model** rows after optout\_confirmations: pending\_receipts and job\_runs (copy them from `docs/SPEC.md`).

#82 (FR-9 window, audit O-43-1) changed the **Implementation status** FR-9 row and the end of the **Data model** review\_requests notes ("; maybe\_sent\_at is the first time a send (text or email) may have reached the customer and also dates the 90-day rule (FR-9, #82)"). It also changed FR-9's requirement text (adds "; a request counts from the first time it may have reached the customer to the last (a send whose outcome is unknown counts, and still counts if the request is later skipped) (decided 2026-11-27, O-43-1)" before " | Must") and added a ticked item under **Decisions needed**, "Which date an ask counts from (O-43-1, FR-9)", after D-19 (owner decision 2026-11-27). Copy all four from `docs/SPEC.md`.

sync-2026-11-27-02 (SPEC sync at main 9d771e1) moved the header line to 9d771e1, the first sentence under **Implementation status** to "Status of each requirement on main at 9d771e1 (2026-11-27).", and added a last sentence to the FR-9 status row ("A request that may have gone out still counts after it is later skipped …"). Copy them from `docs/SPEC.md`.

sync-2026-11-27-04 (SPEC sync rerun at main 9d771e1) changed the **Implementation status** FR-9 row: its status is now "Implemented, one failure-path gap (noncompliant)", and the row ends with the T-82-1 note (test in #88) and the A-82-1 gap (fix in #87). Copy the row from `docs/SPEC.md`.

The Google endpoint guard PR #86 (2026-11-27, SPEC Provider notes: Google OAuth) adds one **Implementation status** row after "Retention (Security)": "Google least privilege (Provider notes)". Copy the row from `docs/SPEC.md` into the Doc.

The retention purge PR #95 (audit O-59-1, 2026-11-28) adds one sentence to the **Implementation status** "Retention (Security)" row, before "Offboarding itself has no app path yet (FR-20).": "In both steps a business or location whose delete fails is rolled back (for a location, only its failing batch of up to 500 customers), logged by ID and error code only and skipped, the others are still deleted in the same run (after 3 lost database connections in a row the step stops, and the rest wait for the retry or the next daily run), and the step then fails so the queue retries the purge job (audit O-59-1, PR #95)." Copy the row from `docs/SPEC.md`.
