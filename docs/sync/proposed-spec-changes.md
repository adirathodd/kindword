# Claude Doc edits still needed

The Claude Doc (https://claude.ai/artifact/2MP1j84JD2TXC7B8SwriPs) was last brought level with `docs/SPEC.md` at main 33bea94 (Doc rev 268). These later PRs changed `docs/SPEC.md` only, all in the **Implementation status** table:

| PR                                                      | Rows                                                   |
| ------------------------------------------------------- | ------------------------------------------------------ |
| #44 (job scheduler)                                     | FR-2a, FR-5, FR-6, FR-11, FR-12, FR-13, FR-22          |
| #53 (monthly report)                                    | FR-17                                                  |
| #58 (status after #54 operator alerts and #55 Node pin) | FR-11, FR-19, FR-24                                    |
| sync-2026-11-26-02 (SPEC sync at main f3d6d49)          | FR-2, FR-7, FR-17, FR-23, new Retention (Security) row |
| #51 (operator sign-in and business setup, FR-1)         | FR-1                                                   |

sync-2026-11-26-02 also changed two lines outside the table: the header line ("Last synced against main f3d6d49") and a new item under **Decisions needed**, "Consent evidence retention (D-13, …)", added after D-12.

Simplest fix: replace the Doc's Implementation status table with the one in `docs/SPEC.md` on main, update the header line and add the D-13 item, and keep everything else. No other section differs. The sessions that made these edits had no Claude Docs connector, so the owner applies them (CLAUDE.md, Source of truth).

#51 also added "Operator access (D-16, …)" under **Decisions needed**, after the last D item.

When a later PR changes `docs/SPEC.md`, make the same edit in the Doc, or list it here.
