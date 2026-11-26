# Claude Doc edits still needed

The Claude Doc (https://claude.ai/artifact/2MP1j84JD2TXC7B8SwriPs) was last brought level with `docs/SPEC.md` at main 33bea94 (Doc rev 268). These later PRs changed `docs/SPEC.md` only, all in the **Implementation status** table:

| PR                                                      | Rows                                                   |
| ------------------------------------------------------- | ------------------------------------------------------ |
| #44 (job scheduler)                                     | FR-2a, FR-5, FR-6, FR-11, FR-12, FR-13, FR-22          |
| #53 (monthly report)                                    | FR-17                                                  |
| #58 (status after #54 operator alerts and #55 Node pin) | FR-11, FR-19, FR-24                                    |
| sync-2026-11-26-02 (SPEC sync at main f3d6d49)          | FR-2, FR-7, FR-17, FR-23, new Retention (Security) row |

sync-2026-11-26-02 also changed two lines outside the table: the header line ("Last synced against main f3d6d49") and a new item under **Decisions needed**, "Consent evidence retention (D-13, …)", added after D-12.

Simplest fix: replace the Doc's Implementation status table with the one in `docs/SPEC.md` on main, update the header line and add the D-13 item, and keep everything else. No other section differs. The sessions that made these edits had no Claude Docs connector, so the owner applies them (CLAUDE.md, Source of truth).

When a later PR changes `docs/SPEC.md`, make the same edit in the Doc, or list it here.

The D-2 and multi-business accounts PR (2026-11-26: change note, FR-13, new FR-25 and its status row, account\_businesses in the Data model, the Security scoping line, the Week 2 gate, D-2 decided, the F-40-1 note, new items D-14 to D-18) was applied to the Doc directly (Doc rev 279) and needs no further Doc edit. The follow-up that marks F-40-1 resolved by #68 (FR-13 status row and the F-40-1 item) was also applied directly (Doc rev 282). In the Doc, D-14 to D-18 sit at the end of the list, where D-13 will also go once the items above are applied.
