# Real-user done bar (Red, 2026-10-03, revised 10:40 AM PT)

Set by Red on 2026-10-03 at 10:40 AM PT. It replaces both the 10:23 AM version and done-when tests 1-5 from the Oct 1 reduced scope.

**Sandboxes stay a generic remote (Parsa's simpler bar). Doppler injection and implicit GitHub auth stay out of scope.**

Every step is done through the real Windows UI:

1. The Open project, New project and GitHub buttons on the main Pane page work on the active host, not the local machine.
2. Clone from GitHub clones montlakev2 onto the sandbox. Implicit gh auth is not required: an unauthenticated user gets whatever error they would normally get. Agree with Red on what that error and UX actually are before building, in case something custom is needed.
3. A new pane lands on the sandbox in its correct worktree. Claude Code, Codex and Terminal in that pane all work: they run on the sandbox, in the worktree, and their basic functions are confirmed.
4. Doppler injection is skipped. The user runs `doppler login` themselves.
5. Implicit GitHub login is skipped. The user signs the sandbox in to GitHub when they create it, like any remote. They probably need a terminal on the host before opening a repo pane. State whether Pane already supports this.
6. To finish, an agent edits a file, commits, pushes a branch and opens a draft PR on montlakev2.

## Reporting rule

Every done report lists each real-user UI step that was exercised, with evidence from the actual Windows UI (screenshots or a recording). A step without UI evidence counts as not done. The result is audited element by element by cs-auditor.

## Superseded: 10:23 AM PT version

The 10:23 AM version, which brought Doppler secrets and GitHub credentials back into scope, is superseded by this revision and no longer applies.
