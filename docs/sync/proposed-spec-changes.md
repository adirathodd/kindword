# Claude Doc edits still needed

The Claude Doc (https://claude.ai/artifact/2MP1j84JD2TXC7B8SwriPs) was last brought level with `docs/SPEC.md` at main 33bea94 (Doc rev 268). These later PRs changed `docs/SPEC.md` only, mostly in the **Implementation status** table:

| PR                                                      | Rows                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| #44 (job scheduler)                                     | FR-2a, FR-5, FR-6, FR-11, FR-12, FR-13, FR-22                                  |
| #53 (monthly report)                                    | FR-17                                                                          |
| #58 (status after #54 operator alerts and #55 Node pin) | FR-11, FR-19, FR-24                                                            |
| sync-2026-11-26-02 (SPEC sync at main f3d6d49)          | FR-2, FR-7, FR-17, FR-23, new Retention (Security) row                         |
| #72 (opt-out confirmation, F-9-2)                       | FR-8                                                                           |
| sync-2026-11-26-04 (SPEC sync at main 3fefa4c)          | FR-5, FR-6, FR-7, FR-8, FR-9, FR-13, FR-20, FR-23, FR-24, Retention (Security) |

sync-2026-11-26-02 also changed two lines outside the table: the header line ("Last synced against main f3d6d49") and a new item under **Decisions needed**, "Consent evidence retention (D-13, …)", added after D-12.

Simplest fix: replace the Doc's text with `docs/SPEC.md` from main and keep the two diagrams. The sessions that made these edits had no Claude Docs connector, so the owner applies them (CLAUDE.md, Source of truth).

#69 also changed FR-9's requirement text (a duplicate skip stays skipped) and marked the F-7-4 item under **Decisions needed** decided.

sync-2026-11-26-04 also changed, outside the table: the header line (now 3fefa4c); the **Data model** rows for businesses (offboarded\_at) and review\_requests (outcome\_unknown, send\_attempts, maybe\_sent\_at) and a new optout\_confirmations row; under **Decisions needed**, the F-40-1 item is marked resolved by #68, and the D-11 item says F-9-2 is fixed by #72.

When a later PR changes `docs/SPEC.md`, make the same edit in the Doc, or list it here.
