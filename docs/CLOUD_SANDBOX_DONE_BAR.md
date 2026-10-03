# Real-user done bar (Red, 2026-10-03)

Set by Red on 2026-10-03, 10:23 AM PT. This replaces done-when tests 1-5 (Oct 1 reduced scope) as the definition of done for Runpane Cloud.

**E2E means the real user path through the app UI. API or script shortcuts never count.**

Done when all of the following are done through the Windows desktop UI on SOBECK:

1. The user creates a sandbox through the UI.
2. The user connects their repo (montlakev2) through the UI. First find out how base Pane handles repos on a new remote: are they copied over from local, or must the user connect or clone them? Either way, connecting must work.
3. The user opens each supported terminal type through its UI path: Claude Code, Codex and plain Terminal.
4. The Terminal opens inside the sandbox. Claude Code and Codex start in the correct worktree on the sandbox.
5. The agents can see the appropriate secrets and have the appropriate GitHub credentials.

Note: secrets and GitHub credentials were out of the Oct 1 reduced scope (Doppler secrets, GitHub broker). Red is now bringing them back in. What "appropriate" means is proposed below and needs Red's confirmation.

## Reporting rule

Every done report must list each real-user UI step that was exercised, with evidence from the actual Windows UI (screenshots or a recording). A step without UI evidence counts as not done.

## How it is proven

- A test kit drives the real Electron UI on SOBECK, clicking the same buttons a user would (Playwright against the Electron window). It takes a screenshot at every step and records the run.
- The test checks results inside the sandbox read-only, for example the terminal's `pwd`, `git worktree list`, the Claude and Codex process cwd, `gh auth status`, and the names of secrets that are present (never their values).
- cs-auditor audits element by element against this bar.

## Proposed meaning of "appropriate" (awaiting Red's confirmation)

- Secrets: the Doppler config montlake/dev is injected into agent panels on the sandbox through the existing Doppler manifest, policy and stand-in. Only the names are checked; values are never printed.
- GitHub: a repo-scoped credential for montlakev2 that can fetch, push branches and open PRs, issued through the existing GitHub App broker and the `gh` stand-in. No personal token is stored on the sandbox.
