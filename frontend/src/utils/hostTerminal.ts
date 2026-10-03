// TEMPORARY STUB (cs-clone-auth): cs-host-terminal owns this module and its
// real implementation replaces this file at rebase. Same signature as their
// posted contract: opens the active host's terminal and types `input` with no
// Enter; throws on failure.
export async function openHostTerminal({ input }: { input?: string }): Promise<void> {
  window.dispatchEvent(new CustomEvent('pane:host-terminal-stub-open', { detail: { input } }));
}
