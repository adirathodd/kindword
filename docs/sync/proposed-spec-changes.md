# Claude Doc edits still needed

The Claude Doc (https://claude.ai/artifact/2MP1j84JD2TXC7B8SwriPs) was last brought level with `docs/SPEC.md` at main 33bea94 (Doc rev 268). These later PRs changed `docs/SPEC.md` only, all in the **Implementation status** table:

| PR                                                          | Rows                                          |
| ----------------------------------------------------------- | --------------------------------------------- |
| #44 (job scheduler)                                         | FR-2a, FR-5, FR-6, FR-11, FR-12, FR-13, FR-22 |
| #53 (monthly report)                                        | FR-17                                         |
| this PR (status after #54 operator alerts and #55 Node pin) | FR-11, FR-19, FR-24                           |

Simplest fix: replace the Doc's Implementation status table with the one in `docs/SPEC.md` on main, and keep everything else. No other section differs. The sessions that made these edits had no Claude Docs connector, so the owner applies them (CLAUDE.md, Source of truth).

When a later PR changes `docs/SPEC.md`, make the same edit in the Doc, or list it here.
